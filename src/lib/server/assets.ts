import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Database } from './auth';
import { assets, universes, users } from './db/schema.ts';
import { makeS3Client } from './s3-client.ts';
import { IMAGE_TYPES } from './media-types.ts';

// Uploaded images live in an S3-compatible bucket, deliberately separate
// from the backups bucket: a database restore then keeps every asset link
// valid, and disaster recovery stays one story. Off until configured.

export type AssetConfig = {
	endpoint: string | undefined;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
};

export function assetConfig(env: Record<string, string | undefined> = process.env) {
	const bucket = env.ASSET_S3_BUCKET;
	const accessKeyId = env.ASSET_S3_ACCESS_KEY_ID;
	const secretAccessKey = env.ASSET_S3_SECRET_ACCESS_KEY;
	if (!bucket || !accessKeyId || !secretAccessKey) return null;
	return {
		endpoint: env.ASSET_S3_ENDPOINT || undefined,
		region: env.ASSET_S3_REGION || 'auto',
		bucket,
		prefix: (env.ASSET_S3_PREFIX || 'codex-assets').replace(/\/+$/, ''),
		accessKeyId,
		secretAccessKey
	} satisfies AssetConfig;
}

export type AssetObjectStore = {
	put(key: string, body: Buffer, contentType: string): Promise<void>;
	get(key: string): Promise<Readable>;
	remove(key: string): Promise<void>;
};

export function s3AssetStore(config: AssetConfig): AssetObjectStore {
	const client = makeS3Client(config);
	return {
		async put(key, body, contentType) {
			await client.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: key,
					Body: body,
					ContentType: contentType
				})
			);
		},
		async get(key) {
			const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
			if (!object.Body) throw new Error(`empty object: ${key}`);
			return object.Body as Readable;
		},
		async remove(key) {
			await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
		}
	};
}

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export type AssetInput = {
	universeId: string | null;
	kind: 'inline' | 'cover' | 'avatar';
	filename: string;
	contentType: string;
	bytes: Buffer;
};

export async function createAsset(
	db: Database,
	store: AssetObjectStore,
	config: AssetConfig,
	userId: string,
	input: AssetInput
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
	if (!IMAGE_TYPES.has(input.contentType)) {
		return { ok: false, reason: 'only png, jpeg, webp, gif, and avif images are supported' };
	}
	if (input.bytes.length === 0) return { ok: false, reason: 'the file is empty' };
	if (input.bytes.length > MAX_ASSET_BYTES) {
		return { ok: false, reason: 'the file is larger than 10 MB' };
	}
	if (input.universeId) {
		const [universe] = await db
			.select({ id: universes.id })
			.from(universes)
			.where(and(eq(universes.id, input.universeId), eq(universes.ownerId, userId)));
		if (!universe) return { ok: false, reason: 'universe not found' };
	}

	const id = randomUUID();
	const storageKey = `${config.prefix}/${id}`;
	await store.put(storageKey, input.bytes, input.contentType);
	try {
		await db.insert(assets).values({
			id,
			ownerId: userId,
			universeId: input.universeId,
			kind: input.kind,
			filename: input.filename.slice(0, 255) || 'upload',
			contentType: input.contentType,
			byteSize: input.bytes.length,
			storageKey
		});
	} catch (error) {
		// No orphaned objects: if the row cannot land, the object goes too.
		await store.remove(storageKey).catch(() => {});
		throw error;
	}
	return { ok: true, id };
}

// The asset row plus its content stream, ownership checked.
export async function openAsset(
	db: Database,
	store: AssetObjectStore,
	userId: string,
	assetId: string
) {
	const [row] = await db
		.select()
		.from(assets)
		.where(and(eq(assets.id, assetId), eq(assets.ownerId, userId)));
	if (!row) return null;
	return { asset: row, body: await store.get(row.storageKey) };
}

export async function deleteAsset(
	db: Database,
	store: AssetObjectStore,
	userId: string,
	assetId: string
): Promise<boolean> {
	const deleted = await db
		.delete(assets)
		.where(and(eq(assets.id, assetId), eq(assets.ownerId, userId)))
		.returning({ storageKey: assets.storageKey });
	if (deleted.length === 0) return false;
	await store.remove(deleted[0].storageKey).catch(() => {});
	return true;
}

// Uploads a new account avatar and points the user at it, then removes the
// previous avatar so old images do not pile up.
export async function setUserAvatar(
	db: Database,
	store: AssetObjectStore,
	config: AssetConfig,
	userId: string,
	input: { filename: string; contentType: string; bytes: Buffer }
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
	const result = await createAsset(db, store, config, userId, {
		universeId: null,
		kind: 'avatar',
		filename: input.filename,
		contentType: input.contentType,
		bytes: input.bytes
	});
	if (!result.ok) return result;
	// Lock the row, read its current avatar, then point it at the new one, all in
	// one transaction. The FOR UPDATE lock serialises concurrent uploads, so each
	// sees the value its predecessor actually left and deletes exactly that,
	// rather than racing on a stale read and orphaning the loser's asset.
	const previous = await db.transaction(async (tx) => {
		const [user] = await tx
			.select({ avatarAssetId: users.avatarAssetId })
			.from(users)
			.where(eq(users.id, userId))
			.for('update');
		await tx.update(users).set({ avatarAssetId: result.id }).where(eq(users.id, userId));
		return user?.avatarAssetId ?? null;
	});
	if (previous && previous !== result.id) {
		await deleteAsset(db, store, userId, previous).catch(() => {});
	}
	return { ok: true, id: result.id };
}

// Clears the account avatar and removes its stored image. Falls back to
// initials wherever the avatar is shown.
export async function clearUserAvatar(
	db: Database,
	store: AssetObjectStore,
	userId: string
): Promise<void> {
	// Same locked read-then-write as setUserAvatar, so a clear racing an upload
	// cannot leave the just-uploaded image orphaned.
	const previous = await db.transaction(async (tx) => {
		const [user] = await tx
			.select({ avatarAssetId: users.avatarAssetId })
			.from(users)
			.where(eq(users.id, userId))
			.for('update');
		const current = user?.avatarAssetId ?? null;
		if (current) await tx.update(users).set({ avatarAssetId: null }).where(eq(users.id, userId));
		return current;
	});
	if (previous) await deleteAsset(db, store, userId, previous).catch(() => {});
}
