import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Database } from './auth.ts';
import { assets, exportArtifacts, universes, users } from './db/schema.ts';
import { makeS3Client } from './s3-client.ts';
import { sniffImageType } from './media-types.ts';
import { encryptSecret, secretsAvailable } from './crypto.ts';
import {
	clearSetting,
	effectiveS3,
	readSetting,
	s3SettingsView,
	saveS3Settings,
	writeSetting,
	type S3SettingsView,
	type SaveS3Input,
	type SaveS3Result,
	type StoredS3
} from './settings.ts';

// Uploaded images live in an S3-compatible bucket, deliberately separate
// from the backups bucket: a database restore then keeps every asset link
// valid, and disaster recovery stays one story. Off until configured, in
// the admin panel or through the ASSET_S3_* environment variables; settings
// saved in the panel win, the environment is the seed.

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

const ASSETS_KEY = 'asset-storage';
const ASSET_PREFIX_DEFAULT = 'codex-assets';

// The effective asset storage: settings saved in the admin panel win, the
// environment is the fallback for instances configured the old way.
export async function effectiveAssetConfig(db: Database): Promise<AssetConfig | null> {
	const stored = await effectiveS3(db, ASSETS_KEY);
	if (stored) {
		return {
			endpoint: stored.endpoint || undefined,
			region: stored.region || 'auto',
			bucket: stored.bucket,
			prefix: stored.prefix,
			accessKeyId: stored.accessKeyId,
			secretAccessKey: stored.secretAccessKey
		};
	}
	return assetConfig();
}

export async function assetStorageView(db: Database): Promise<S3SettingsView> {
	return s3SettingsView(db, ASSETS_KEY, assetConfig());
}

// Saves the asset storage settings. When storage that already holds objects
// is being pointed somewhere else, the old connection is stashed first so a
// migration can copy the objects over (see the migration functions below).
export async function saveAssetStorage(db: Database, input: SaveS3Input): Promise<SaveS3Result> {
	const previous = await effectiveAssetConfig(db);
	const result = await saveS3Settings(db, ASSETS_KEY, input, ASSET_PREFIX_DEFAULT);
	if (!result.ok) return result;
	const next = await effectiveAssetConfig(db);
	if (
		previous &&
		next &&
		(previous.bucket !== next.bucket ||
			(previous.endpoint ?? '') !== (next.endpoint ?? '') ||
			previous.region !== next.region) &&
		(await countStoredObjects(db)) > 0
	) {
		await stashMigrationSource(db, previous);
	}
	return result;
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
	kind: 'inline' | 'cover' | 'avatar' | 'badge';
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
	if (input.bytes.length === 0) return { ok: false, reason: 'the file is empty' };
	if (input.bytes.length > MAX_ASSET_BYTES) {
		return { ok: false, reason: 'the file is larger than 10 MB' };
	}
	// Trust the bytes, not the client-supplied content type: sniff the magic
	// number and store (and later serve) the detected type, so arbitrary bytes
	// cannot be stashed under an image label.
	const contentType = sniffImageType(input.bytes);
	if (!contentType) {
		return { ok: false, reason: 'only png, jpeg, webp, gif, and avif images are supported' };
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
	await store.put(storageKey, input.bytes, contentType);
	try {
		await db.insert(assets).values({
			id,
			ownerId: userId,
			universeId: input.universeId,
			kind: input.kind,
			filename: input.filename.slice(0, 255) || 'upload',
			contentType,
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

// ============ Storage migration ============
// When the asset settings move to a different bucket or host, the objects
// already uploaded stay behind. Saving such a change stashes the previous
// connection; the admin can then run a copy job (or dismiss the offer), and
// the worker streams every known object from the old storage to the new.
// Keys are copied verbatim, so nothing in the database needs rewriting.

const ASSET_MIGRATION_KEY = 'asset-storage-migration';

async function stashMigrationSource(db: Database, config: AssetConfig): Promise<void> {
	if (!secretsAvailable()) return;
	const value: StoredS3 = {
		endpoint: config.endpoint ?? '',
		region: config.region,
		bucket: config.bucket,
		prefix: config.prefix,
		accessKeyId: config.accessKeyId,
		secretAccessKeyEnc: encryptSecret(config.secretAccessKey)
	};
	await writeSetting(db, ASSET_MIGRATION_KEY, value);
}

// The stashed previous connection, or null when there is nothing to migrate.
export async function assetMigrationSource(db: Database): Promise<AssetConfig | null> {
	const stored = await effectiveS3(db, ASSET_MIGRATION_KEY);
	if (!stored) return null;
	return {
		endpoint: stored.endpoint || undefined,
		region: stored.region || 'auto',
		bucket: stored.bucket,
		prefix: stored.prefix,
		accessKeyId: stored.accessKeyId,
		secretAccessKey: stored.secretAccessKey
	};
}

export async function clearAssetMigrationSource(db: Database): Promise<void> {
	await clearSetting(db, ASSET_MIGRATION_KEY);
}

// The outcome of the last copy run, shown in the admin panel. The worker
// records it; failures keep the stash so the copy can be run again.
const ASSET_MIGRATION_RESULT_KEY = 'asset-storage-migration-result';

export type AssetMigrationResult = { finishedAt: string; copied: number; failed: number };

export async function recordAssetMigrationResult(
	db: Database,
	result: AssetMigrationResult
): Promise<void> {
	await writeSetting(db, ASSET_MIGRATION_RESULT_KEY, result);
}

export async function assetMigrationResult(db: Database): Promise<AssetMigrationResult | null> {
	return readSetting<AssetMigrationResult>(db, ASSET_MIGRATION_RESULT_KEY);
}

// Every object the database knows about: uploaded assets plus the stored
// export files of published editions, which live in the same bucket.
export async function listStoredObjects(
	db: Database
): Promise<{ storageKey: string; contentType: string }[]> {
	const uploaded = await db
		.select({ storageKey: assets.storageKey, contentType: assets.contentType })
		.from(assets);
	const artifacts = await db
		.select({ storageKey: exportArtifacts.storageKey, contentType: exportArtifacts.contentType })
		.from(exportArtifacts);
	return [...uploaded, ...artifacts];
}

async function countStoredObjects(db: Database): Promise<number> {
	return (await listStoredObjects(db)).length;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

// Copies every known object from one store to the other. A missing or
// unreadable object is counted and skipped rather than stopping the run, so
// one lost image cannot strand the rest.
export async function migrateAssetObjects(
	db: Database,
	source: AssetObjectStore,
	target: AssetObjectStore
): Promise<{ copied: number; failed: number }> {
	let copied = 0;
	let failed = 0;
	for (const object of await listStoredObjects(db)) {
		try {
			const body = await streamToBuffer(await source.get(object.storageKey));
			await target.put(object.storageKey, body, object.contentType);
			copied += 1;
		} catch (error) {
			failed += 1;
			console.error(`asset migration: ${object.storageKey} failed:`, error);
		}
	}
	return { copied, failed };
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
