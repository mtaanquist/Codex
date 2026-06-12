// Mention index rebuilds. Runs in the worker (plain Node), so relative value
// imports carry explicit .ts extensions.
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	characters,
	characterStoryMemberships,
	entityMentions,
	loreEntries,
	places,
	placeStoryMemberships,
	scenes,
	stories
} from './db/schema.ts';
import { detectMentions, mentionSnippet, type MentionTarget } from '../mention-detect.ts';
import { listMentionPins } from './mention-pins.ts';

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
	targets: MentionTarget[];
	stories: Map<string, { members: Set<string>; pins: Awaited<ReturnType<typeof listMentionPins>> }>;
};

export async function universeMentionContext(
	db: Database,
	universeId: string
): Promise<MentionRebuildContext> {
	const cast = await db
		.select({ id: characters.id, name: characters.name, aliases: characters.aliases })
		.from(characters)
		.where(and(eq(characters.universeId, universeId), eq(characters.autoDetectMentions, true)));
	const placeRows = await db
		.select({ id: places.id, name: places.name, aliases: places.aliases })
		.from(places)
		.where(and(eq(places.universeId, universeId), eq(places.autoDetectMentions, true)));
	const loreRows = await db
		.select({ id: loreEntries.id, title: loreEntries.title, keywords: loreEntries.keywords })
		.from(loreEntries)
		.where(and(eq(loreEntries.universeId, universeId), eq(loreEntries.autoDetectMentions, true)));
	const targets: MentionTarget[] = [
		...cast.map(
			(character): MentionTarget => ({
				id: character.id,
				type: 'character',
				names: [character.name, ...character.aliases]
			})
		),
		...placeRows.map(
			(place): MentionTarget => ({
				id: place.id,
				type: 'place',
				names: [place.name, ...place.aliases]
			})
		),
		...loreRows.map(
			(entry): MentionTarget => ({
				id: entry.id,
				type: 'lore_entry',
				names: [entry.title, ...entry.keywords]
			})
		)
	];
	return { universeId, targets, stories: new Map() };
}

async function storyContext(db: Database, context: MentionRebuildContext, storyId: string) {
	let ctx = context.stories.get(storyId);
	if (!ctx) {
		ctx = { members: await storyMemberIds(db, storyId), pins: await listMentionPins(db, storyId) };
		context.stories.set(storyId, ctx);
	}
	return ctx;
}

export async function rebuildSceneMentions(
	db: Database,
	sceneId: string,
	context?: MentionRebuildContext
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
	const [scene] = await db
		.select({
			id: scenes.id,
			bodyMd: scenes.bodyMd,
			storyId: scenes.storyId,
			universeId: stories.universeId,
			deletedAt: scenes.deletedAt
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(eq(scenes.id, sceneId));
	if (!scene) return { ok: false, reason: 'scene not found' };
	// A trashed scene holds no mentions. Clear and stamp so a rebuild queued
	// before the deletion cannot re-add rows, and the reconcile sweep settles.
	if (scene.deletedAt) {
		await db.transaction(async (tx) => {
			await tx
				.delete(entityMentions)
				.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
			await tx.execute(sql`update scenes set mentions_indexed_at = now() where id = ${scene.id}`);
		});
		return { ok: true, count: 0 };
	}

	// A caller-supplied context only applies to its own universe; a single
	// scene rebuild builds a fresh one.
	const shared =
		context?.universeId === scene.universeId
			? context
			: await universeMentionContext(db, scene.universeId);
	const { members, pins } = await storyContext(db, shared, scene.storyId);
	const found = detectMentions(scene.bodyMd, shared.targets, {
		storyMembers: members,
		pins
	});

	await db.transaction(async (tx) => {
		await tx
			.delete(entityMentions)
			.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
		if (found.length > 0) {
			await tx.insert(entityMentions).values(
				found.map((match) => ({
					sourceType: 'scene',
					sourceId: scene.id,
					targetType: match.targetType,
					targetId: match.targetId,
					position: match.position,
					surroundingText: mentionSnippet(scene.bodyMd, match.position, match.length)
				}))
			);
		}
		// Stamp the watermark in the same transaction. Raw SQL so it does not trip
		// the scene's updated_at $onUpdate, which would make every scene look
		// perpetually stale. now() marks "indexed as of this instant"; a later
		// body or entity change moves past it and the reconcile sweep catches it.
		await tx.execute(sql`update scenes set mentions_indexed_at = now() where id = ${scene.id}`);
	});
	return { ok: true, count: found.length };
}

// After a character's name or aliases change, every scene in the universe may
// gain or lose mentions.
export async function rebuildUniverseMentions(db: Database, universeId: string): Promise<number> {
	const sceneRows = await db
		.select({ id: scenes.id })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(eq(stories.universeId, universeId));
	// One entity fetch for the whole sweep; only the per-scene body read and
	// mention write stay in the loop.
	const context = await universeMentionContext(db, universeId);
	for (const row of sceneRows) {
		await rebuildSceneMentions(db, row.id, context);
	}
	return sceneRows.length;
}

// Scenes whose mention index is behind: never indexed, or indexed before the
// scene's body last changed, or before any character/place/lore in its universe
// last changed (an alias edit that should add or drop mentions). This is the
// backstop for a dropped rebuild job, which would otherwise leave the index
// stale until the next manual save. Ordered oldest-first so the longest-stale
// scenes are caught first; bounded so one sweep cannot run unbounded.
export async function listStaleMentionScenes(
	db: Database,
	limit = 200
): Promise<{ id: string; universeId: string }[]> {
	const result = await db.execute(sql`
		select s.id, st.universe_id
		from scenes s
		join stories st on st.id = s.story_id
		where s.mentions_indexed_at is null
			or s.mentions_indexed_at < s.updated_at
			or s.mentions_indexed_at < greatest(
				coalesce((select max(updated_at) from characters where universe_id = st.universe_id), to_timestamp(0)),
				coalesce((select max(updated_at) from places where universe_id = st.universe_id), to_timestamp(0)),
				coalesce((select max(updated_at) from lore_entries where universe_id = st.universe_id), to_timestamp(0))
			)
		order by s.mentions_indexed_at asc nulls first
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
	return stale.length;
}
