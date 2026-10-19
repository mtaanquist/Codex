import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	characters,
	entityCategories,
	entityRelationships,
	loreEntries,
	notes,
	places,
	relationTypes,
	reviewSuggestions,
	reviewThreads,
	revisions,
	scenes,
	stories
} from './db/schema.ts';
import { wordCount } from '$lib/word-count';
import {
	snapshotsEqual,
	type EntitySnapshot,
	type SnapshotRelationship
} from '$lib/entity-snapshot';
import { entityInUniverse, namesByType, type EntityType } from './entity-lookups.ts';
import { remapMarkerAnchors } from './markers.ts';
import { inLiveUniverse } from './universe-scope.ts';

export type RevisionEntityType =
	'scene' | 'character' | 'place' | 'lore_entry' | 'chapter' | 'note';

export type RevisionReason = 'autosave' | 'checkpoint' | 'restore' | 'suggestion';

// Consecutive autosaves within this window roll the same revision row forward
// instead of appending, so a writing burst leaves one timeline entry rather
// than one per pause. A gap longer than this starts a fresh autosave entry.
const AUTOSAVE_COALESCE_MS = 2 * 60 * 1000;

// A scene revision pinned as the base of a review thread or suggestion is the
// exact text those anchors diff against, so it must never be coalesced into:
// rolling its body forward would silently re-anchor every pinned comment and
// mis-apply accepted suggestions. Only scene revisions are ever pinned.
async function isPinnedBaseRevision(db: Database, revisionId: string): Promise<boolean> {
	const [thread] = await db
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.where(eq(reviewThreads.baseRevisionId, revisionId))
		.limit(1);
	if (thread) return true;
	const [suggestion] = await db
		.select({ id: reviewSuggestions.id })
		.from(reviewSuggestions)
		.where(eq(reviewSuggestions.baseRevisionId, revisionId))
		.limit(1);
	return Boolean(suggestion);
}

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
	const words = wordCount(bodyMd);
	if (reason !== 'autosave') {
		await db.insert(revisions).values({
			entityType,
			entityId,
			bodyMd,
			wordCount: words,
			snapshot,
			reason,
			label: options.label?.trim() || null
		});
		return { recorded: true };
	}
	// Read-latest then coalesce-or-insert is a check-then-act race: two tabs
	// saving the same entity at once could both read the same latest row and
	// both write. A per-entity transaction-scoped advisory lock serialises them,
	// so the second save sees the first's result.
	return await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${entityType}:${entityId}`}))`);
		const [latest] = await tx
			.select({
				id: revisions.id,
				// Compared in the database so a long body is not read back each save.
				sameBody: sql<boolean>`${revisions.bodyMd} = ${bodyMd}`,
				snapshot: revisions.snapshot,
				reason: revisions.reason,
				createdAt: revisions.createdAt
			})
			.from(revisions)
			.where(and(eq(revisions.entityType, entityType), eq(revisions.entityId, entityId)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		if (latest && latest.sameBody && snapshotsEqual(latest.snapshot, snapshot)) {
			return { recorded: false };
		}
		if (
			latest &&
			latest.reason === 'autosave' &&
			Date.now() - latest.createdAt.getTime() < AUTOSAVE_COALESCE_MS &&
			!(entityType === 'scene' && (await isPinnedBaseRevision(tx, latest.id)))
		) {
			await tx
				.update(revisions)
				.set({ bodyMd, wordCount: words, snapshot, createdAt: sql`now()` })
				.where(eq(revisions.id, latest.id));
			return { recorded: true };
		}
		await tx.insert(revisions).values({
			entityType,
			entityId,
			bodyMd,
			wordCount: words,
			snapshot,
			reason,
			label: options.label?.trim() || null
		});
		return { recorded: true };
	});
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
		base = {
			name: row.name,
			aliases: row.aliases,
			summaryMd: row.summaryMd,
			categoryId: row.categoryId
		};
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
// appropriate to its type. Scenes own nothing directly, so ownership flows
// through the story.
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
			.where(
				and(
					eq(scenes.id, entityId),
					eq(stories.ownerId, userId),
					inLiveUniverse(stories.universeId)
				)
			);
		return row ?? null;
	}
	if (entityType === 'character') {
		const [row] = await db
			.select({ bodyMd: characters.bodyMd })
			.from(characters)
			.where(
				and(
					eq(characters.id, entityId),
					eq(characters.ownerId, userId),
					inLiveUniverse(characters.universeId)
				)
			);
		return row ?? null;
	}
	if (entityType === 'place') {
		const [row] = await db
			.select({ bodyMd: places.bodyMd })
			.from(places)
			.where(
				and(eq(places.id, entityId), eq(places.ownerId, userId), inLiveUniverse(places.universeId))
			);
		return row ?? null;
	}
	if (entityType === 'lore_entry') {
		const [row] = await db
			.select({ bodyMd: loreEntries.bodyMd })
			.from(loreEntries)
			.where(
				and(
					eq(loreEntries.id, entityId),
					eq(loreEntries.ownerId, userId),
					inLiveUniverse(loreEntries.universeId)
				)
			);
		return row ?? null;
	}
	if (entityType === 'note') {
		const [row] = await db
			.select({ bodyMd: notes.bodyMd })
			.from(notes)
			.where(
				and(eq(notes.id, entityId), eq(notes.ownerId, userId), inLiveUniverse(notes.universeId))
			);
		return row ?? null;
	}
	// Chapters have no revisable body yet.
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
		// One transaction so the body and its 'restore' snapshot commit together.
		await db.transaction(async (tx) => {
			const [current] = await tx
				.select({ bodyMd: scenes.bodyMd })
				.from(scenes)
				.where(eq(scenes.id, entityId))
				.for('update');
			await tx
				.update(scenes)
				.set({ bodyMd: revision.bodyMd, wordCount: wordCount(revision.bodyMd) })
				.where(eq(scenes.id, entityId));
			if (current) await remapMarkerAnchors(tx, entityId, current.bodyMd, revision.bodyMd);
			await recordRevision(tx, entityType, entityId, revision.bodyMd, 'restore');
		});
		return { ok: true };
	}
	if (entityType === 'note') {
		// Notes restore body-only, like scenes; the title is not revisioned.
		await db.transaction(async (tx) => {
			await tx.update(notes).set({ bodyMd: revision.bodyMd }).where(eq(notes.id, entityId));
			await recordRevision(tx, entityType, entityId, revision.bodyMd, 'restore');
		});
		return { ok: true };
	}
	if (!isSnapshotType(entityType)) {
		return { ok: false, reason: 'that cannot be restored' };
	}

	const before = await buildEntitySnapshot(db, entityType, entityId);
	if (!before) return { ok: false, reason: 'entity not found' };
	const snapshot = revision.snapshot;
	const category = snapshot ? await restorableCategory(db, before.universeId, snapshot) : {};

	// One transaction: the entity update, the relationship reconcile, and every
	// revision snapshot commit together, so a failure part-way cannot leave the
	// entity restored with a half-reconciled relationship set or no 'restore'
	// entry on the timeline.
	await db.transaction(async (tx) => {
		if (entityType === 'character') {
			await tx
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
			await tx
				.update(places)
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
				.where(eq(places.id, entityId));
		} else {
			// Lore always has a category, so a cleared or deleted one keeps the
			// current category rather than setting null.
			const loreCategory =
				'categoryId' in category && category.categoryId !== null
					? { categoryId: category.categoryId }
					: {};
			await tx
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
				tx,
				{ universeId: before.universeId, ownerId: before.ownerId },
				entityType,
				entityId,
				snapshot.relationships
			);
			for (const other of touched) {
				await recordEntityRevision(tx, other.type, other.id);
			}
		}

		await recordEntityRevision(tx, entityType, entityId, 'restore');
	});
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

type TimelineSource = { type: RevisionEntityType; entities: SQL };

// The newest `limit` revisions across a set of entities, newest first. Each
// source yields entity_id, entity_name, story_title and story_slug; a lateral
// limit per entity walks the timeline index, so the cost is bounded by
// entities times `limit` rather than by the whole history. Rows with the same
// timestamp keep the order of `sources` (the order the per-type lists were
// merged in before), then the id, so the listing is stable.
async function recentRevisions(
	db: Database,
	sources: TimelineSource[],
	limit: number
): Promise<TimelineRow[]> {
	const parts = sources.map(
		({ type, entities }, ord) => sql`
			select r.id, r.reason, r.label, r.created_at, ${ord}::int as ord, ${type}::text as entity_type,
				e.entity_id, e.entity_name, e.story_title, e.story_slug
			from (${entities}) e
			cross join lateral (
				select rv.id, rv.reason, rv.label, rv.created_at
				from revisions rv
				where rv.entity_type = ${type} and rv.entity_id = e.entity_id
				order by rv.created_at desc, rv.id desc
				limit ${limit}
			) r`
	);
	const result = await db.execute(sql`
		select * from (${sql.join(parts, sql` union all `)}) x
		order by x.created_at desc, x.ord asc, x.id desc
		limit ${limit}
	`);
	return result.rows.map((row) => {
		const r = row as {
			id: string;
			reason: string | null;
			label: string | null;
			created_at: Date | string;
			entity_type: RevisionEntityType;
			entity_id: string;
			entity_name: string | null;
			story_title: string | null;
			story_slug: string | null;
		};
		return {
			id: r.id,
			reason: r.reason,
			label: r.label,
			createdAt: new Date(r.created_at),
			entityType: r.entity_type,
			entityId: r.entity_id,
			entityName: r.entity_name,
			...(r.story_title !== null ? { storyTitle: r.story_title, storySlug: r.story_slug } : {})
		};
	});
}

// Recent changes across a story's prose, for its settings page. A trashed
// scene's history stays out, the same as the universe timeline.
export async function storyTimeline(
	db: Database,
	storyId: string,
	limit = 50
): Promise<TimelineRow[]> {
	return recentRevisions(
		db,
		[
			{
				type: 'scene',
				entities: sql`
					select id as entity_id, title as entity_name,
						null::text as story_title, null::text as story_slug
					from scenes where story_id = ${storyId} and deleted_at is null`
			}
		],
		limit
	);
}

// Recent changes across a universe's scenes and entities, for its settings
// page.
export async function universeTimeline(
	db: Database,
	universeId: string,
	limit = 50
): Promise<TimelineRow[]> {
	const entity = (table: string, nameColumn: string) => sql`
		select id as entity_id, ${sql.raw(nameColumn)} as entity_name,
			null::text as story_title, null::text as story_slug
		from ${sql.raw(table)} where universe_id = ${universeId}`;
	return recentRevisions(
		db,
		[
			{
				type: 'scene',
				entities: sql`
					select s.id as entity_id, s.title as entity_name,
						st.title as story_title, st.slug as story_slug
					from scenes s join stories st on st.id = s.story_id
					where st.universe_id = ${universeId} and s.deleted_at is null`
			},
			{ type: 'character', entities: entity('characters', 'name') },
			{ type: 'place', entities: entity('places', 'name') },
			{ type: 'lore_entry', entities: entity('lore_entries', 'title') }
		],
		limit
	);
}

// The footer's total: every revision recorded across the universe. One join
// per entity type, so each counts from the timeline index instead of an OR
// over the whole table.
export async function universeRevisionCount(db: Database, universeId: string): Promise<number> {
	const result = await db.execute(sql`
		select (
			(select count(*) from scenes s join stories st on st.id = s.story_id
				join revisions r on r.entity_type = 'scene' and r.entity_id = s.id
				where st.universe_id = ${universeId})
			+ (select count(*) from characters c
				join revisions r on r.entity_type = 'character' and r.entity_id = c.id
				where c.universe_id = ${universeId})
			+ (select count(*) from places p
				join revisions r on r.entity_type = 'place' and r.entity_id = p.id
				where p.universe_id = ${universeId})
			+ (select count(*) from lore_entries l
				join revisions r on r.entity_type = 'lore_entry' and r.entity_id = l.id
				where l.universe_id = ${universeId})
		)::int as total
	`);
	return (result.rows[0] as { total: number }).total;
}

// Autosaves younger than this are all kept. Older ones are thinned to the
// first and last autosave of each entity per UTC day. A local day overlaps at
// most two UTC days, so in any timezone every local day with writing keeps a
// row, and Insights streaks are unchanged.
export const REVISION_FULL_HISTORY_DAYS = 90;
const THIN_BATCH = 5000;

// Thins old autosave history. Never removes a checkpoint, restore or
// suggestion row, the first or last autosave of an entity's UTC day, or a
// revision pinned as the base of a review thread or suggestion. Deletes in
// batches so a first run on a long history does not hold one huge
// transaction. Returns the number of rows removed.
export async function thinRevisions(
	db: Database,
	fullHistoryDays = REVISION_FULL_HISTORY_DAYS
): Promise<number> {
	const cutoff = new Date(Date.now() - fullHistoryDays * 24 * 60 * 60 * 1000);
	let total = 0;
	for (;;) {
		const result = await db.execute(sql`
			delete from revisions where id in (
				select ranked.id from (
					select r.id,
						row_number() over (day_window order by r.created_at desc, r.id desc) as from_last,
						row_number() over (day_window order by r.created_at asc, r.id asc) as from_first
					from revisions r
					where r.reason = 'autosave' and r.created_at < ${cutoff}
					window day_window as (
						partition by r.entity_type, r.entity_id, (r.created_at at time zone 'UTC')::date
					)
				) ranked
				where ranked.from_last > 1 and ranked.from_first > 1
					and not exists (select 1 from review_threads t where t.base_revision_id = ranked.id)
					and not exists (
						select 1 from review_suggestions s where s.base_revision_id = ranked.id)
				limit ${THIN_BATCH}
			)
		`);
		const removed = result.rowCount ?? 0;
		total += removed;
		if (removed < THIN_BATCH) return total;
	}
}
