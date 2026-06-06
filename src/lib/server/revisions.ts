import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	entityCategories,
	entityRelationships,
	loreEntries,
	outlineNodes,
	places,
	relationTypes,
	revisions,
	scenes,
	stories
} from './db/schema';
import { wordCount } from '$lib/word-count';
import {
	snapshotsEqual,
	type EntitySnapshot,
	type SnapshotRelationship
} from '$lib/entity-snapshot';
import { entityInUniverse, namesByType, type EntityType } from './entity-lookups';

export type RevisionEntityType =
	| 'scene'
	| 'character'
	| 'place'
	| 'lore_entry'
	| 'outline_node'
	| 'chapter'
	| 'note';

export type RevisionReason = 'autosave' | 'checkpoint' | 'restore' | 'suggestion';

// Consecutive autosaves within this window roll the same revision row forward
// instead of appending, so a writing burst leaves one timeline entry rather
// than one per pause. A gap longer than this starts a fresh autosave entry.
const AUTOSAVE_COALESCE_MS = 2 * 60 * 1000;

// Records a revision. An autosave skips when nothing changed (body, and for
// entities the structured snapshot), and otherwise coalesces into the latest
// entry when that entry is a recent autosave (rolling its content and
// timestamp forward); past the window, or when the latest entry is a
// checkpoint, it appends a new row. Checkpoints always insert: the point of
// one is the marker, even on unchanged text.
export async function recordRevision(
	db: Database,
	entityType: RevisionEntityType,
	entityId: string,
	bodyMd: string,
	reason: RevisionReason = 'autosave',
	options: { label?: string; snapshot?: EntitySnapshot | null } = {}
): Promise<{ recorded: boolean }> {
	const snapshot = options.snapshot ?? null;
	if (reason === 'autosave') {
		const [latest] = await db
			.select({
				id: revisions.id,
				bodyMd: revisions.bodyMd,
				snapshot: revisions.snapshot,
				reason: revisions.reason,
				createdAt: revisions.createdAt
			})
			.from(revisions)
			.where(and(eq(revisions.entityType, entityType), eq(revisions.entityId, entityId)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		if (latest && latest.bodyMd === bodyMd && snapshotsEqual(latest.snapshot, snapshot)) {
			return { recorded: false };
		}
		if (
			latest &&
			latest.reason === 'autosave' &&
			Date.now() - latest.createdAt.getTime() < AUTOSAVE_COALESCE_MS
		) {
			await db
				.update(revisions)
				.set({ bodyMd, snapshot, createdAt: sql`now()` })
				.where(eq(revisions.id, latest.id));
			return { recorded: true };
		}
	}
	await db.insert(revisions).values({
		entityType,
		entityId,
		bodyMd,
		snapshot,
		reason,
		label: options.label?.trim() || null
	});
	return { recorded: true };
}

export function isSnapshotType(type: RevisionEntityType): type is EntityType {
	return type === 'character' || type === 'place' || type === 'lore_entry';
}

// Serializes the entity's universe-wide relationship rows (both directions),
// ordered by row id so equal sets compare equal. Display strings are
// captured as they are now, so a preview stays readable after the type or
// target is renamed or removed; the ids are what restore works from.
async function snapshotRelationships(
	db: Database,
	universeId: string,
	type: EntityType,
	id: string
): Promise<SnapshotRelationship[]> {
	const rows = await db
		.select({
			relationTypeId: entityRelationships.relationTypeId,
			fromType: entityRelationships.fromType,
			fromId: entityRelationships.fromId,
			toType: entityRelationships.toType,
			toId: entityRelationships.toId,
			notesMd: entityRelationships.notesMd,
			forwardLabel: relationTypes.forwardLabel,
			reverseLabel: relationTypes.reverseLabel,
			bidirectional: relationTypes.bidirectional
		})
		.from(entityRelationships)
		.innerJoin(relationTypes, eq(entityRelationships.relationTypeId, relationTypes.id))
		.where(
			and(
				eq(entityRelationships.universeId, universeId),
				isNull(entityRelationships.storyId),
				or(
					and(eq(entityRelationships.fromType, type), eq(entityRelationships.fromId, id)),
					and(eq(entityRelationships.toType, type), eq(entityRelationships.toId, id))
				)
			)
		)
		.orderBy(asc(entityRelationships.id));

	const serialized = rows.map((row): SnapshotRelationship => {
		const isFrom = row.fromType === type && row.fromId === id;
		return {
			relationTypeId: row.relationTypeId,
			role: isFrom ? 'from' : 'to',
			otherType: (isFrom ? row.toType : row.fromType) as EntityType,
			otherId: isFrom ? row.toId : row.fromId,
			notesMd: row.notesMd,
			label: isFrom || row.bidirectional ? row.forwardLabel : (row.reverseLabel ?? ''),
			otherName: ''
		};
	});
	for (const otherType of ['character', 'place', 'lore_entry'] as const) {
		const ids = serialized
			.filter((relationship) => relationship.otherType === otherType)
			.map((relationship) => relationship.otherId);
		const names = await namesByType(db, otherType, ids);
		for (const relationship of serialized) {
			if (relationship.otherType === otherType) {
				relationship.otherName = names.get(relationship.otherId) ?? 'Unknown';
			}
		}
	}
	return serialized;
}

async function categoryNameById(db: Database, categoryId: string | null): Promise<string | null> {
	if (!categoryId) return null;
	const [row] = await db
		.select({ name: entityCategories.name })
		.from(entityCategories)
		.where(eq(entityCategories.id, categoryId));
	return row?.name ?? null;
}

// The entity's current state, snapshot-shaped, plus the context callers
// need: the body for the revision row, the universe and owner for mention
// rebuilds and relationship rows.
export async function buildEntitySnapshot(
	db: Database,
	type: EntityType,
	id: string
): Promise<{
	snapshot: EntitySnapshot;
	bodyMd: string;
	universeId: string;
	ownerId: string;
} | null> {
	let bodyMd: string;
	let universeId: string;
	let ownerId: string;
	let base: Pick<EntitySnapshot, 'name' | 'aliases' | 'keywords' | 'summaryMd' | 'categoryId'>;
	let details: EntitySnapshot['details'];

	if (type === 'character') {
		const [row] = await db.select().from(characters).where(eq(characters.id, id));
		if (!row) return null;
		({ bodyMd, universeId, ownerId } = row);
		base = {
			name: row.name,
			aliases: row.aliases,
			summaryMd: row.summaryMd,
			categoryId: row.categoryId
		};
		details = row.details;
	} else if (type === 'place') {
		const [row] = await db.select().from(places).where(eq(places.id, id));
		if (!row) return null;
		({ bodyMd, universeId, ownerId } = row);
		base = { name: row.name, summaryMd: row.summaryMd, categoryId: row.categoryId };
		details = row.details;
	} else {
		const [row] = await db.select().from(loreEntries).where(eq(loreEntries.id, id));
		if (!row) return null;
		({ bodyMd, universeId, ownerId } = row);
		base = {
			name: row.title,
			keywords: row.keywords,
			summaryMd: row.summaryMd,
			categoryId: row.categoryId
		};
		details = row.details;
	}

	const snapshot: EntitySnapshot = {
		...base,
		categoryName: await categoryNameById(db, base.categoryId),
		details,
		relationships: await snapshotRelationships(db, universeId, type, id)
	};
	return { snapshot, bodyMd, universeId, ownerId };
}

// Captures a full revision of the entity's current state: the body plus the
// structured snapshot, under the usual autosave coalescing rules. This is
// what makes alias, summary, category, detail, and relationship changes
// register in History even when the body itself is untouched.
export async function recordEntityRevision(
	db: Database,
	type: EntityType,
	id: string,
	reason: RevisionReason = 'autosave',
	label?: string
): Promise<{ recorded: boolean }> {
	const built = await buildEntitySnapshot(db, type, id);
	if (!built) return { recorded: false };
	return await recordRevision(db, type, id, built.bodyMd, reason, {
		label,
		snapshot: built.snapshot
	});
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

// A manual checkpoint of the entity's current state, with an optional name.
export async function createCheckpoint(
	db: Database,
	userId: string,
	entityType: RevisionEntityType,
	entityId: string,
	label?: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const entity = await ownedEntityBody(db, userId, entityType, entityId);
	if (!entity) return { ok: false, reason: 'entity not found' };
	if (isSnapshotType(entityType)) {
		await recordEntityRevision(db, entityType, entityId, 'checkpoint', label);
	} else {
		await recordRevision(db, entityType, entityId, entity.bodyMd, 'checkpoint', { label });
	}
	return { ok: true };
}

// Returns the snapshot's category id when it can still be applied: null
// passes through (clearing is a real state), an id only if the category
// still exists in the universe; a deleted one leaves the current category.
async function restorableCategory(
	db: Database,
	universeId: string,
	snapshot: EntitySnapshot
): Promise<{ categoryId: string | null } | Record<string, never>> {
	if (snapshot.categoryId === null) return { categoryId: null };
	const [row] = await db
		.select({ id: entityCategories.id })
		.from(entityCategories)
		.where(
			and(eq(entityCategories.id, snapshot.categoryId), eq(entityCategories.universeId, universeId))
		);
	return row ? { categoryId: row.id } : {};
}

// Reconciles the entity's universe-wide relationship rows to the snapshot's
// set: rows not in the snapshot go, missing ones are recreated when their
// relation type and target still exist, and ones whose type or target is
// gone are skipped. Returns the other entities whose relationship set
// changed, so their timelines register the change too.
async function reconcileRelationships(
	db: Database,
	context: { universeId: string; ownerId: string },
	type: EntityType,
	id: string,
	desired: SnapshotRelationship[]
): Promise<{ type: EntityType; id: string }[]> {
	const keyOf = (relationship: Omit<SnapshotRelationship, 'label' | 'otherName'>) =>
		[
			relationship.relationTypeId,
			relationship.role,
			relationship.otherType,
			relationship.otherId,
			relationship.notesMd ?? ''
		].join('|');

	const currentRows = await db
		.select()
		.from(entityRelationships)
		.where(
			and(
				eq(entityRelationships.universeId, context.universeId),
				isNull(entityRelationships.storyId),
				or(
					and(eq(entityRelationships.fromType, type), eq(entityRelationships.fromId, id)),
					and(eq(entityRelationships.toType, type), eq(entityRelationships.toId, id))
				)
			)
		);
	const current = currentRows.map((row) => {
		const isFrom = row.fromType === type && row.fromId === id;
		return {
			row,
			otherType: (isFrom ? row.toType : row.fromType) as EntityType,
			otherId: isFrom ? row.toId : row.fromId,
			key: keyOf({
				relationTypeId: row.relationTypeId,
				role: isFrom ? 'from' : 'to',
				otherType: (isFrom ? row.toType : row.fromType) as EntityType,
				otherId: isFrom ? row.toId : row.fromId,
				notesMd: row.notesMd
			})
		};
	});

	const touched = new Map<string, { type: EntityType; id: string }>();
	const desiredKeys = new Set(desired.map(keyOf));
	for (const entry of current) {
		if (desiredKeys.has(entry.key)) continue;
		await db.delete(entityRelationships).where(eq(entityRelationships.id, entry.row.id));
		touched.set(`${entry.otherType}:${entry.otherId}`, {
			type: entry.otherType,
			id: entry.otherId
		});
	}

	const currentKeys = new Set(current.map((entry) => entry.key));
	for (const relationship of desired) {
		if (currentKeys.has(keyOf(relationship))) continue;
		const [relationType] = await db
			.select()
			.from(relationTypes)
			.where(
				and(
					eq(relationTypes.id, relationship.relationTypeId),
					or(isNull(relationTypes.universeId), eq(relationTypes.universeId, context.universeId))
				)
			);
		if (!relationType) continue;
		const fromType = relationship.role === 'from' ? type : relationship.otherType;
		const toType = relationship.role === 'from' ? relationship.otherType : type;
		if (relationType.fromType !== fromType || relationType.toType !== toType) continue;
		if (
			!(await entityInUniverse(
				db,
				context.universeId,
				relationship.otherType,
				relationship.otherId
			))
		) {
			continue;
		}
		await db.insert(entityRelationships).values({
			universeId: context.universeId,
			ownerId: context.ownerId,
			fromType,
			fromId: relationship.role === 'from' ? id : relationship.otherId,
			toType,
			toId: relationship.role === 'from' ? relationship.otherId : id,
			relationTypeId: relationship.relationTypeId,
			notesMd: relationship.notesMd
		});
		touched.set(`${relationship.otherType}:${relationship.otherId}`, {
			type: relationship.otherType,
			id: relationship.otherId
		});
	}
	return [...touched.values()];
}

// Restore never overwrites history: the entity gets the revision's content
// and a new 'restore' revision lands on top of the timeline. An entity
// revision with a snapshot restores the whole entity - name, aliases or
// keywords, summary, category, details, and the relationship set - while
// older body-only rows restore the body and leave the rest as it is. Parts
// of a snapshot that point at things deleted since (a category, a relation
// type, a related entity) are skipped rather than recreated.
export async function restoreRevision(
	db: Database,
	userId: string,
	revisionId: string,
	entityType: RevisionEntityType,
	entityId: string
): Promise<
	{ ok: true; universeId?: string; mentionsAffected?: boolean } | { ok: false; reason: string }
> {
	const entity = await ownedEntityBody(db, userId, entityType, entityId);
	if (!entity) return { ok: false, reason: 'entity not found' };
	const revision = await getRevision(db, revisionId, entityType, entityId);
	if (!revision) return { ok: false, reason: 'revision not found' };

	if (entityType === 'scene') {
		await db
			.update(scenes)
			.set({ bodyMd: revision.bodyMd, wordCount: wordCount(revision.bodyMd) })
			.where(eq(scenes.id, entityId));
		await recordRevision(db, entityType, entityId, revision.bodyMd, 'restore');
		return { ok: true };
	}
	if (entityType === 'outline_node') {
		await db
			.update(outlineNodes)
			.set({ bodyMd: revision.bodyMd })
			.where(eq(outlineNodes.id, entityId));
		await recordRevision(db, entityType, entityId, revision.bodyMd, 'restore');
		return { ok: true };
	}
	if (!isSnapshotType(entityType)) {
		return { ok: false, reason: 'that cannot be restored' };
	}

	const before = await buildEntitySnapshot(db, entityType, entityId);
	if (!before) return { ok: false, reason: 'entity not found' };
	const snapshot = revision.snapshot;
	const category = snapshot ? await restorableCategory(db, before.universeId, snapshot) : {};

	if (entityType === 'character') {
		await db
			.update(characters)
			.set({
				bodyMd: revision.bodyMd,
				...(snapshot
					? {
							name: snapshot.name,
							aliases: snapshot.aliases ?? [],
							summaryMd: snapshot.summaryMd,
							details: snapshot.details,
							...category
						}
					: {})
			})
			.where(eq(characters.id, entityId));
	} else if (entityType === 'place') {
		await db
			.update(places)
			.set({
				bodyMd: revision.bodyMd,
				...(snapshot
					? {
							name: snapshot.name,
							summaryMd: snapshot.summaryMd,
							details: snapshot.details,
							...category
						}
					: {})
			})
			.where(eq(places.id, entityId));
	} else {
		// Lore always has a category, so a cleared or deleted one keeps the
		// current category rather than setting null.
		const loreCategory =
			'categoryId' in category && category.categoryId !== null
				? { categoryId: category.categoryId }
				: {};
		await db
			.update(loreEntries)
			.set({
				bodyMd: revision.bodyMd,
				...(snapshot
					? {
							title: snapshot.name,
							keywords: snapshot.keywords ?? [],
							summaryMd: snapshot.summaryMd,
							details: snapshot.details,
							...loreCategory
						}
					: {})
			})
			.where(eq(loreEntries.id, entityId));
	}

	if (snapshot) {
		const touched = await reconcileRelationships(
			db,
			{ universeId: before.universeId, ownerId: before.ownerId },
			entityType,
			entityId,
			snapshot.relationships
		);
		for (const other of touched) {
			await recordEntityRevision(db, other.type, other.id);
		}
	}

	await recordEntityRevision(db, entityType, entityId, 'restore');
	const mentionsAffected = snapshot
		? JSON.stringify([snapshot.name, snapshot.aliases ?? [], snapshot.keywords ?? []]) !==
			JSON.stringify([
				before.snapshot.name,
				before.snapshot.aliases ?? [],
				before.snapshot.keywords ?? []
			])
		: false;
	return { ok: true, universeId: before.universeId, mentionsAffected };
}

export type TimelineRow = RevisionRow & {
	entityType: RevisionEntityType;
	entityId: string;
	entityName: string | null;
	// Set for scene rows in the universe timeline; entities carry null.
	storyTitle?: string | null;
	storySlug?: string | null;
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

// Recent changes across a universe's scenes and entities, for its settings
// page.
export async function universeTimeline(
	db: Database,
	universeId: string,
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
			entityName: scenes.title,
			storyTitle: stories.title,
			storySlug: stories.slug
		})
		.from(revisions)
		.innerJoin(scenes, eq(revisions.entityId, scenes.id))
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(revisions.entityType, 'scene'),
				eq(stories.universeId, universeId),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(desc(revisions.createdAt))
		.limit(limit);
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
	return mergeTimelines([sceneRows, characterRows, placeRows, loreRows], limit);
}

// The footer's total: every revision recorded across the universe.
export async function universeRevisionCount(db: Database, universeId: string): Promise<number> {
	const result = await db.execute(sql`
		select count(*)::int as total from revisions r
		where (r.entity_type = 'scene' and r.entity_id in (
				select s.id from scenes s join stories st on st.id = s.story_id
				where st.universe_id = ${universeId}))
			or (r.entity_type = 'character' and r.entity_id in (
				select id from characters where universe_id = ${universeId}))
			or (r.entity_type = 'place' and r.entity_id in (
				select id from places where universe_id = ${universeId}))
			or (r.entity_type = 'lore_entry' and r.entity_id in (
				select id from lore_entries where universe_id = ${universeId}))
	`);
	return (result.rows[0] as { total: number }).total;
}
