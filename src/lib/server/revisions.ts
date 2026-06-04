import { and, desc, eq } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	loreEntries,
	outlineNodes,
	places,
	revisions,
	scenes,
	stories
} from './db/schema';
import { wordCount } from '$lib/word-count';

export type RevisionEntityType =
	| 'scene'
	| 'character'
	| 'place'
	| 'lore_entry'
	| 'outline_node'
	| 'chapter'
	| 'note';

export type RevisionReason = 'autosave' | 'checkpoint' | 'restore';

// Appends a revision unless the body matches the latest one, so title-only
// and metadata saves do not pile up identical copies. Checkpoints always
// insert: the point of one is the marker, even on unchanged text.
export async function recordRevision(
	db: Database,
	entityType: RevisionEntityType,
	entityId: string,
	bodyMd: string,
	reason: RevisionReason = 'autosave',
	label?: string
): Promise<{ recorded: boolean }> {
	if (reason === 'autosave') {
		const [latest] = await db
			.select({ bodyMd: revisions.bodyMd })
			.from(revisions)
			.where(and(eq(revisions.entityType, entityType), eq(revisions.entityId, entityId)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		if (latest && latest.bodyMd === bodyMd) return { recorded: false };
	}
	await db.insert(revisions).values({
		entityType,
		entityId,
		bodyMd,
		reason,
		label: label?.trim() || null
	});
	return { recorded: true };
}

export type RevisionRow = {
	id: string;
	reason: string | null;
	label: string | null;
	createdAt: Date;
};

// The timeline for one open item, newest first. Bodies stay out of the
// listing; they are fetched one at a time for preview and diff.
export async function listRevisions(
	db: Database,
	entityType: RevisionEntityType,
	entityId: string,
	limit = 50
): Promise<RevisionRow[]> {
	return await db
		.select({
			id: revisions.id,
			reason: revisions.reason,
			label: revisions.label,
			createdAt: revisions.createdAt
		})
		.from(revisions)
		.where(and(eq(revisions.entityType, entityType), eq(revisions.entityId, entityId)))
		.orderBy(desc(revisions.createdAt))
		.limit(limit);
}

export async function getRevision(
	db: Database,
	revisionId: string,
	entityType: RevisionEntityType,
	entityId: string
) {
	const [row] = await db
		.select()
		.from(revisions)
		.where(
			and(
				eq(revisions.id, revisionId),
				// Scoped to the entity, so a revision id cannot leak another
				// item's text past the caller's ownership check.
				eq(revisions.entityType, entityType),
				eq(revisions.entityId, entityId)
			)
		);
	return row;
}

// Loads the current body of any revisable entity, with an ownership check
// appropriate to its type. Scenes and outline nodes own nothing directly,
// so ownership flows through the story.
export async function ownedEntityBody(
	db: Database,
	userId: string,
	entityType: RevisionEntityType,
	entityId: string
): Promise<{ bodyMd: string } | null> {
	if (entityType === 'scene') {
		const [row] = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.innerJoin(stories, eq(scenes.storyId, stories.id))
			.where(and(eq(scenes.id, entityId), eq(stories.ownerId, userId)));
		return row ?? null;
	}
	if (entityType === 'outline_node') {
		const [row] = await db
			.select({ bodyMd: outlineNodes.bodyMd })
			.from(outlineNodes)
			.innerJoin(stories, eq(outlineNodes.storyId, stories.id))
			.where(and(eq(outlineNodes.id, entityId), eq(stories.ownerId, userId)));
		return row ?? null;
	}
	if (entityType === 'character') {
		const [row] = await db
			.select({ bodyMd: characters.bodyMd })
			.from(characters)
			.where(and(eq(characters.id, entityId), eq(characters.ownerId, userId)));
		return row ?? null;
	}
	if (entityType === 'place') {
		const [row] = await db
			.select({ bodyMd: places.bodyMd })
			.from(places)
			.where(and(eq(places.id, entityId), eq(places.ownerId, userId)));
		return row ?? null;
	}
	if (entityType === 'lore_entry') {
		const [row] = await db
			.select({ bodyMd: loreEntries.bodyMd })
			.from(loreEntries)
			.where(and(eq(loreEntries.id, entityId), eq(loreEntries.ownerId, userId)));
		return row ?? null;
	}
	// Chapters and notes have no revisable body yet.
	return null;
}

// A manual checkpoint of the entity's current text, with an optional name.
export async function createCheckpoint(
	db: Database,
	userId: string,
	entityType: RevisionEntityType,
	entityId: string,
	label?: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const entity = await ownedEntityBody(db, userId, entityType, entityId);
	if (!entity) return { ok: false, reason: 'entity not found' };
	await recordRevision(db, entityType, entityId, entity.bodyMd, 'checkpoint', label);
	return { ok: true };
}

// Restore never overwrites history: the entity gets the revision's text and
// a new 'restore' revision lands on top of the timeline.
export async function restoreRevision(
	db: Database,
	userId: string,
	revisionId: string,
	entityType: RevisionEntityType,
	entityId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const entity = await ownedEntityBody(db, userId, entityType, entityId);
	if (!entity) return { ok: false, reason: 'entity not found' };
	const revision = await getRevision(db, revisionId, entityType, entityId);
	if (!revision) return { ok: false, reason: 'revision not found' };

	if (entityType === 'scene') {
		await db
			.update(scenes)
			.set({ bodyMd: revision.bodyMd, wordCount: wordCount(revision.bodyMd) })
			.where(eq(scenes.id, entityId));
	} else if (entityType === 'outline_node') {
		await db
			.update(outlineNodes)
			.set({ bodyMd: revision.bodyMd })
			.where(eq(outlineNodes.id, entityId));
	} else if (entityType === 'character') {
		await db.update(characters).set({ bodyMd: revision.bodyMd }).where(eq(characters.id, entityId));
	} else if (entityType === 'place') {
		await db.update(places).set({ bodyMd: revision.bodyMd }).where(eq(places.id, entityId));
	} else if (entityType === 'lore_entry') {
		await db
			.update(loreEntries)
			.set({ bodyMd: revision.bodyMd })
			.where(eq(loreEntries.id, entityId));
	} else {
		return { ok: false, reason: 'that cannot be restored' };
	}

	await recordRevision(db, entityType, entityId, revision.bodyMd, 'restore');
	return { ok: true };
}

export type TimelineRow = RevisionRow & {
	entityType: RevisionEntityType;
	entityId: string;
	entityName: string | null;
};

function mergeTimelines(lists: TimelineRow[][], limit: number): TimelineRow[] {
	return lists
		.flat()
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
		.slice(0, limit);
}

// Recent changes across a story's prose and outline, for its settings page.
export async function storyTimeline(
	db: Database,
	storyId: string,
	limit = 50
): Promise<TimelineRow[]> {
	const sceneRows = await db
		.select({
			id: revisions.id,
			reason: revisions.reason,
			label: revisions.label,
			createdAt: revisions.createdAt,
			entityType: revisions.entityType,
			entityId: revisions.entityId,
			entityName: scenes.title
		})
		.from(revisions)
		.innerJoin(scenes, eq(revisions.entityId, scenes.id))
		.where(and(eq(revisions.entityType, 'scene'), eq(scenes.storyId, storyId)))
		.orderBy(desc(revisions.createdAt))
		.limit(limit);
	const nodeRows = await db
		.select({
			id: revisions.id,
			reason: revisions.reason,
			label: revisions.label,
			createdAt: revisions.createdAt,
			entityType: revisions.entityType,
			entityId: revisions.entityId,
			entityName: outlineNodes.title
		})
		.from(revisions)
		.innerJoin(outlineNodes, eq(revisions.entityId, outlineNodes.id))
		.where(and(eq(revisions.entityType, 'outline_node'), eq(outlineNodes.storyId, storyId)))
		.orderBy(desc(revisions.createdAt))
		.limit(limit);
	return mergeTimelines([sceneRows, nodeRows], limit);
}

// Recent changes across a universe's entities, for its settings page.
export async function universeTimeline(
	db: Database,
	universeId: string,
	limit = 50
): Promise<TimelineRow[]> {
	const characterRows = await db
		.select({
			id: revisions.id,
			reason: revisions.reason,
			label: revisions.label,
			createdAt: revisions.createdAt,
			entityType: revisions.entityType,
			entityId: revisions.entityId,
			entityName: characters.name
		})
		.from(revisions)
		.innerJoin(characters, eq(revisions.entityId, characters.id))
		.where(and(eq(revisions.entityType, 'character'), eq(characters.universeId, universeId)))
		.orderBy(desc(revisions.createdAt))
		.limit(limit);
	const placeRows = await db
		.select({
			id: revisions.id,
			reason: revisions.reason,
			label: revisions.label,
			createdAt: revisions.createdAt,
			entityType: revisions.entityType,
			entityId: revisions.entityId,
			entityName: places.name
		})
		.from(revisions)
		.innerJoin(places, eq(revisions.entityId, places.id))
		.where(and(eq(revisions.entityType, 'place'), eq(places.universeId, universeId)))
		.orderBy(desc(revisions.createdAt))
		.limit(limit);
	const loreRows = await db
		.select({
			id: revisions.id,
			reason: revisions.reason,
			label: revisions.label,
			createdAt: revisions.createdAt,
			entityType: revisions.entityType,
			entityId: revisions.entityId,
			entityName: loreEntries.title
		})
		.from(revisions)
		.innerJoin(loreEntries, eq(revisions.entityId, loreEntries.id))
		.where(and(eq(revisions.entityType, 'lore_entry'), eq(loreEntries.universeId, universeId)))
		.orderBy(desc(revisions.createdAt))
		.limit(limit);
	return mergeTimelines([characterRows, placeRows, loreRows], limit);
}
