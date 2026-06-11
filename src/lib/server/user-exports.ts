import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { stories, universes, userExports } from './db/schema';
import type { AssetObjectStore } from './assets';
import {
	bucketAssetLoader,
	buildAccountExport,
	buildStoryZip,
	buildUniverseExport,
	gatherStory
} from './export';
import { buildEpub } from './epub';
import { reviewLoader } from './export-reviews';
import { storyPageSetup } from './page-setup';

// User-requested exports (account, story, or universe archive, or a story
// EPUB). The heavy in-memory build and zip run in the worker, never on the web
// request path, so one large export cannot freeze the instance. The finished
// file lands in the asset bucket and the owner downloads it from /exports/[id].

export type ExportScope = 'account' | 'story' | 'universe';
export type ExportFormat = 'zip' | 'epub';

// How long a finished export stays downloadable before it is swept.
export const EXPORT_TTL_HOURS = 24;
// At most this many exports per owner survive; requesting another sweeps the
// oldest, so stored archives never accumulate.
const MAX_EXPORTS_PER_OWNER = 10;

export type ExportRow = typeof userExports.$inferSelect;

const CONTENT_TYPE: Record<ExportFormat, string> = {
	zip: 'application/zip',
	epub: 'application/epub+zip'
};

export type RequestExportInput = {
	scope: ExportScope;
	targetId?: string | null;
	format: ExportFormat;
};

// Validate the request belongs to the owner, then record a pending row. The
// caller enqueues the worker job and marks the row failed if the enqueue fails.
export async function requestExport(
	db: Database,
	ownerId: string,
	input: RequestExportInput
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
	if (input.scope === 'account') {
		if (input.format !== 'zip') return { ok: false, reason: 'Account exports are zip only.' };
	} else if (input.scope === 'universe') {
		if (input.format !== 'zip') return { ok: false, reason: 'Universe exports are zip only.' };
		if (!input.targetId) return { ok: false, reason: 'No universe given.' };
		const [row] = await db
			.select({ id: universes.id })
			.from(universes)
			.where(
				and(
					eq(universes.id, input.targetId),
					eq(universes.ownerId, ownerId),
					isNull(universes.deletedAt)
				)
			);
		if (!row) return { ok: false, reason: 'That universe does not exist.' };
	} else {
		if (!input.targetId) return { ok: false, reason: 'No story given.' };
		// Unlike the universe branch, no trashed-universe filter: an export is
		// the safety net, so a story stays exportable while its universe sits
		// in the trash.
		const [row] = await db
			.select({ id: stories.id })
			.from(stories)
			.where(and(eq(stories.id, input.targetId), eq(stories.ownerId, ownerId)));
		if (!row) return { ok: false, reason: 'That story does not exist.' };
	}

	const expiresAt = new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000);
	const [created] = await db
		.insert(userExports)
		.values({
			ownerId,
			scope: input.scope,
			targetId: input.scope === 'account' ? null : input.targetId,
			format: input.format,
			status: 'pending',
			expiresAt
		})
		.returning({ id: userExports.id });
	return { ok: true, id: created.id };
}

// Marks a pending export failed, used when the worker enqueue itself fails so
// the row does not sit pending forever. (The enqueue lives in the page action,
// not here, so this module stays importable by the worker.)
export async function markExportFailed(
	db: Database,
	exportId: string,
	reason: string
): Promise<void> {
	await db
		.update(userExports)
		.set({ status: 'failed', error: reason })
		.where(and(eq(userExports.id, exportId), eq(userExports.status, 'pending')));
}

// Builds the requested export and stores it in the bucket, run by the worker.
// Returns the owner id on success so the caller can notify them.
export async function runUserExport(
	db: Database,
	exportId: string,
	store: AssetObjectStore
): Promise<{ ok: true; ownerId: string } | { ok: false; reason: string }> {
	const [row] = await db.select().from(userExports).where(eq(userExports.id, exportId));
	if (!row) return { ok: false, reason: 'export not found' };
	if (row.status !== 'pending') return { ok: false, reason: 'export already handled' };

	try {
		const loadAssets = bucketAssetLoader(db, row.ownerId);
		let built: { filename: string; bytes: Uint8Array };

		if (row.scope === 'account') {
			built = await buildAccountExport(db, row.ownerId, loadAssets, reviewLoader(db));
		} else if (row.scope === 'universe') {
			const [universe] = await db
				.select()
				.from(universes)
				.where(and(eq(universes.id, row.targetId!), eq(universes.ownerId, row.ownerId)));
			if (!universe) throw new Error('universe not found');
			built = await buildUniverseExport(db, universe, loadAssets);
		} else {
			const [story] = await db
				.select()
				.from(stories)
				.where(and(eq(stories.id, row.targetId!), eq(stories.ownerId, row.ownerId)));
			if (!story) throw new Error('story not found');
			const content = await gatherStory(db, story);
			built =
				row.format === 'epub'
					? await buildEpub(
							story,
							content,
							loadAssets,
							story.coverAssetId,
							await storyPageSetup(db, story.id)
						)
					: await buildStoryZip(story, content, loadAssets);
		}

		const contentType = CONTENT_TYPE[row.format];
		const storageKey = `exports/${row.ownerId}/${row.id}.${row.format}`;
		await store.put(storageKey, Buffer.from(built.bytes), contentType);
		await db
			.update(userExports)
			.set({
				status: 'ready',
				storageKey,
				filename: built.filename,
				contentType,
				byteSize: built.bytes.byteLength
			})
			.where(eq(userExports.id, row.id));
		return { ok: true, ownerId: row.ownerId };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await db
			.update(userExports)
			.set({ status: 'failed', error: reason })
			.where(eq(userExports.id, row.id));
		return { ok: false, reason };
	}
}

// The owner-gated row for the download route: ready, owned, and not expired.
export async function exportForDownload(
	db: Database,
	exportId: string,
	userId: string
): Promise<ExportRow | null> {
	const [row] = await db
		.select()
		.from(userExports)
		.where(
			and(
				eq(userExports.id, exportId),
				eq(userExports.ownerId, userId),
				eq(userExports.status, 'ready')
			)
		);
	if (!row || !row.storageKey) return null;
	if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
	return row;
}

// The owner's recent exports for one scope (and target), newest first, for the
// page that requests them.
export async function listUserExports(
	db: Database,
	ownerId: string,
	filter: { scope: ExportScope; targetId?: string | null }
): Promise<ExportRow[]> {
	const conditions = [eq(userExports.ownerId, ownerId), eq(userExports.scope, filter.scope)];
	conditions.push(
		filter.targetId ? eq(userExports.targetId, filter.targetId) : isNull(userExports.targetId)
	);
	return db
		.select()
		.from(userExports)
		.where(and(...conditions))
		.orderBy(desc(userExports.createdAt))
		.limit(5);
}

// Removes the owner's expired and over-limit exports, deleting their stored
// objects too. Run by the worker after a build so archives never pile up.
export async function pruneOwnerExports(
	db: Database,
	store: AssetObjectStore,
	ownerId: string
): Promise<void> {
	const rows = await db
		.select({
			id: userExports.id,
			storageKey: userExports.storageKey,
			expiresAt: userExports.expiresAt
		})
		.from(userExports)
		.where(eq(userExports.ownerId, ownerId))
		.orderBy(desc(userExports.createdAt));
	const now = Date.now();
	const doomed = rows.filter(
		(row, index) =>
			index >= MAX_EXPORTS_PER_OWNER || (row.expiresAt != null && row.expiresAt.getTime() < now)
	);
	for (const row of doomed) {
		if (row.storageKey) {
			try {
				await store.remove(row.storageKey);
			} catch (error) {
				console.error(`pruning export object ${row.storageKey} failed:`, error);
			}
		}
		await db.delete(userExports).where(eq(userExports.id, row.id));
	}
}
