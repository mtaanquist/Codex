// Mention index rebuilds. Runs in the worker.
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	characterStoryMemberships,
	entityMentions,
	placeStoryMemberships,
	scenes,
	stories
} from './db/schema.ts';
import { detectMentions, mentionSnippet, type MentionTarget } from '../mention-detect.ts';
import { listMentionPins } from './mention-pins.ts';
import {
	ENTITY_TYPES,
	entityAliasColumn,
	entityNameColumn,
	entityTable,
	type EntityType
} from './entity-lookups.ts';
import { markEntitiesStale } from './scene-lifecycle.ts';
import { storyAssistantOn } from './universe-scope.ts';

// Entities declared in the scene's story outrank the rest when a name is
// shared; see the attribution rules in mention-detect.
async function storyMemberIds(db: Database, storyId: string): Promise<Set<string>> {
	const characterRows = await db
		.select({ id: characterStoryMemberships.characterId })
		.from(characterStoryMemberships)
		.where(eq(characterStoryMemberships.storyId, storyId));
	const placeRows = await db
		.select({ id: placeStoryMemberships.placeId })
		.from(placeStoryMemberships)
		.where(eq(placeStoryMemberships.storyId, storyId));
	return new Set([...characterRows, ...placeRows].map((row) => row.id));
}

// Everything a rebuild needs that is scene-independent: the universe's
// detection targets, plus per-story members and pins cached as they are
// first seen. Universe-wide rebuilds and the reconcile sweep build one of
// these per universe so the loop does not re-fetch the whole entity set for
// every scene (review finding #192).
export type MentionRebuildContext = {
	universeId: string;
	// Database time just before the targets were read. Scenes indexed with this
	// context are stamped with it, not with their own write time, so a rename
	// that lands while the context is in use still leaves them stale.
	loadedAt: Date;
	targets: MentionTarget[];
	stories: Map<string, { members: Set<string>; pins: Awaited<ReturnType<typeof listMentionPins>> }>;
};

export async function universeMentionContext(
	db: Database,
	universeId: string
): Promise<MentionRebuildContext> {
	const [{ loadedAt }] = (await db.execute(sql`select now() as "loadedAt"`)).rows as {
		loadedAt: Date;
	}[];
	const targets: MentionTarget[] = [];
	for (const type of ENTITY_TYPES) {
		const table = entityTable(type);
		const rows = await db
			.select({ id: table.id, name: entityNameColumn(table), aliases: entityAliasColumn(table) })
			.from(table)
			.where(and(eq(table.universeId, universeId), eq(table.autoDetectMentions, true)));
		for (const row of rows) targets.push({ id: row.id, type, names: [row.name, ...row.aliases] });
	}
	return { universeId, loadedAt, targets, stories: new Map() };
}

async function storyContext(db: Database, context: MentionRebuildContext, storyId: string) {
	let ctx = context.stories.get(storyId);
	if (!ctx) {
		ctx = { members: await storyMemberIds(db, storyId), pins: await listMentionPins(db, storyId) };
		context.stories.set(storyId, ctx);
	}
	return ctx;
}

type MentionPassages = {
	targetType: EntityType;
	targetId: string;
	position: number;
	surroundingText: string;
};

// The entities whose passages in a scene differ between two indexings of it:
// mentioned only in one, or quoted with different surrounding text or in a
// different order (an arc reads a scene's first passage). These are the ones
// whose arc and enrichment read something new. A status change, a rename
// elsewhere, or text added that only shifts positions reindexes the scene
// without changing any of them.
export function changedTargets(
	before: MentionPassages[],
	after: MentionPassages[]
): { targetType: EntityType; targetId: string }[] {
	const targets = new Map<string, { targetType: EntityType; targetId: string }>();
	const passages = (rows: MentionPassages[]) => {
		const byTarget = new Map<string, string[]>();
		for (const { targetType, targetId, surroundingText } of [...rows].sort(
			(a, b) => a.position - b.position
		)) {
			const key = `${targetType}:${targetId}`;
			targets.set(key, { targetType, targetId });
			byTarget.set(key, [...(byTarget.get(key) ?? []), surroundingText]);
		}
		return new Map([...byTarget].map(([key, texts]) => [key, JSON.stringify(texts)]));
	};
	const was = passages(before);
	const now = passages(after);
	return [...targets].filter(([key]) => was.get(key) !== now.get(key)).map(([, target]) => target);
}

export async function rebuildSceneMentions(
	db: Database,
	sceneId: string,
	context?: MentionRebuildContext
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
	const missing = { ok: false as const, reason: 'That scene no longer exists.' };
	const [head] = await db
		.select({ storyId: scenes.storyId, universeId: stories.universeId })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(eq(scenes.id, sceneId));
	if (!head) return missing;
	// A caller-supplied context only applies to its own universe; a single
	// scene rebuild builds a fresh one. Either way its load time is before the
	// body is read below.
	const shared =
		context?.universeId === head.universeId
			? context
			: await universeMentionContext(db, head.universeId);
	const { members, pins } = await storyContext(db, shared, head.storyId);

	return await db.transaction(async (tx) => {
		// The scene row first, then the story, then entities: the order saves,
		// reorders, trash, merge and the summary job take, so none of them can
		// deadlock with a rebuild. The body is read under the row lock, so no
		// save can land between the read and the stamp: the index always
		// matches the text it is stamped against.
		const [scene] = await tx
			.select({ id: scenes.id, bodyMd: scenes.bodyMd, deletedAt: scenes.deletedAt })
			.from(scenes)
			.where(eq(scenes.id, sceneId))
			.for('update');
		if (!scene) return missing;
		const clear = () =>
			tx
				.delete(entityMentions)
				.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
		// A trashed scene holds no mentions. Clear and stamp so a rebuild queued
		// before the deletion cannot re-add rows, and the reconcile sweep settles.
		// Raw SQL so the stamp does not trip the scene's updated_at $onUpdate,
		// which would make every scene look perpetually stale.
		if (scene.deletedAt) {
			await clear();
			await tx.execute(sql`update scenes set mentions_indexed_at = now() where id = ${scene.id}`);
			return { ok: true as const, count: 0 };
		}

		const found = detectMentions(scene.bodyMd, shared.targets, { storyMembers: members, pins });
		const rows = found.map((match) => ({
			sourceType: 'scene',
			sourceId: scene.id,
			targetType: match.targetType,
			targetId: match.targetId,
			position: match.position,
			surroundingText: mentionSnippet(scene.bodyMd, match.position, match.length)
		}));

		// The watermark is the context's load time, so "indexed against the
		// names as of then"; a later body save or flagged name change moves past
		// it and the reconcile sweep catches it.
		await tx.execute(
			sql`update scenes set mentions_indexed_at = ${shared.loadedAt} where id = ${scene.id}`
		);
		// Whether the Assistant reads this scene's story. Restoring a story or
		// unmuting it marks what it mentions, so a change made while it was out
		// of reach needs no mark. The share lock waits for a restore or mute in
		// flight, so the mark and that change cannot miss each other. A trashed
		// universe still marks: nothing in it is read until it is restored, and
		// the restore then has nothing left to mark.
		const [reach] = await tx
			.select({ reads: sql<boolean>`${stories.deletedAt} is null and ${storyAssistantOn()}` })
			.from(stories)
			.where(eq(stories.id, head.storyId))
			.for('share');
		const previous = await clear().returning({
			targetType: entityMentions.targetType,
			targetId: entityMentions.targetId,
			position: entityMentions.position,
			surroundingText: entityMentions.surroundingText
		});
		if (rows.length > 0) await tx.insert(entityMentions).values(rows);
		if (reach?.reads) await markEntitiesStale(tx, changedTargets(previous, rows));
		return { ok: true as const, count: found.length };
	});
}

// Records that the universe's detection targets changed (a name, alias,
// keyword, pin, or new entity), so the reconcile sweep reindexes its scenes
// even if the universe rebuild job is dropped. Raw SQL so it does not bump the
// universe's updated_at. Call it before queueing the rebuild, so the scenes
// the job stamps land past it.
export async function markUniverseMentionsChanged(db: Database, universeId: string): Promise<void> {
	await db.execute(sql`update universes set mentions_changed_at = now() where id = ${universeId}`);
}

// Clears the pending flag on every flagged universe (or just the one given)
// whose live scenes have all been reindexed since it was set. Scenes carry the
// time their names were read, so a change that lands mid-rebuild (even after
// the context was loaded) moves mentions_changed_at past them and the flag
// survives until they are reindexed with the new names.
async function settleUniverseMentions(db: Database, universeId?: string): Promise<void> {
	await db.execute(sql`
		update universes u set mentions_changed_at = null
		where u.mentions_changed_at is not null
			${universeId ? sql`and u.id = ${universeId}` : sql``}
			and not exists (
				select 1 from scenes s
				join stories st on st.id = s.story_id
				where st.universe_id = u.id
					and s.deleted_at is null
					and (s.mentions_indexed_at is null or s.mentions_indexed_at < u.mentions_changed_at)
			)
	`);
}

// After a character's name or aliases change, every scene in the universe may
// gain or lose mentions.
export async function rebuildUniverseMentions(db: Database, universeId: string): Promise<number> {
	const sceneRows = await db
		.select({ id: scenes.id })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		// Trashed scenes hold no mentions; their rebuild would only clear and
		// stamp them again.
		.where(and(eq(stories.universeId, universeId), isNull(scenes.deletedAt)));
	// One entity fetch for the whole sweep; only the per-scene body read and
	// mention write stay in the loop.
	const context = await universeMentionContext(db, universeId);
	for (const row of sceneRows) {
		await rebuildSceneMentions(db, row.id, context);
	}
	await settleUniverseMentions(db, universeId);
	return sceneRows.length;
}

// Scenes whose mention index is behind: never indexed, indexed before the
// scene's body last changed, or (live scenes only) indexed before its
// universe's detection targets last changed. Entity edits that touch no names
// do not count. This is the backstop for a dropped rebuild job, which would
// otherwise leave the index stale until the next manual save. Each half reads
// only scenes needing work: the first through a partial index, the second only
// in universes with a pending change. Oldest-first so the longest-stale scenes
// are caught first; bounded so one sweep cannot run unbounded.
export async function listStaleMentionScenes(
	db: Database,
	limit = 200
): Promise<{ id: string; universeId: string }[]> {
	const result = await db.execute(sql`
		select id, universe_id from (
			(
				select s.id, st.universe_id, s.mentions_indexed_at
				from scenes s
				join stories st on st.id = s.story_id
				where s.mentions_indexed_at is null or s.mentions_indexed_at < s.updated_at
				order by s.mentions_indexed_at asc nulls first
				limit ${limit}
			)
			union
			(
				select s.id, st.universe_id, s.mentions_indexed_at
				from universes u
				join stories st on st.universe_id = u.id
				join scenes s on s.story_id = st.id
				where u.mentions_changed_at is not null
					and s.deleted_at is null
					and s.mentions_indexed_at < u.mentions_changed_at
				order by s.mentions_indexed_at asc
				limit ${limit}
			)
		) stale
		order by mentions_indexed_at asc nulls first
		limit ${limit}
	`);
	return result.rows.map((row) => {
		const r = row as { id: string; universe_id: string };
		return { id: r.id, universeId: r.universe_id };
	});
}

// Re-indexes every stale scene found in one bounded pass. Returns how many were
// rebuilt, so the worker can log a non-empty sweep. Idempotent: a scene already
// in step with its content is left alone.
export async function reconcileMentions(db: Database, limit = 200): Promise<number> {
	const stale = await listStaleMentionScenes(db, limit);
	// One shared context per universe in the batch.
	const contexts = new Map<string, MentionRebuildContext>();
	for (const scene of stale) {
		let context = contexts.get(scene.universeId);
		if (!context) {
			context = await universeMentionContext(db, scene.universeId);
			contexts.set(scene.universeId, context);
		}
		await rebuildSceneMentions(db, scene.id, context);
	}
	await settleUniverseMentions(db);
	return stale.length;
}
