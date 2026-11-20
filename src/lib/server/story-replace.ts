import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { sceneMarkers, scenes } from './db/schema';
import { updateMarkerAnchors } from './markers';
import { recordRevision } from './revisions';
import { queueSceneMentions } from './jobs';
import { inLiveStory } from './universe-scope.ts';
import { MAX_PROSE_CHARS } from './validation';
import {
	findMatches,
	matchContext,
	replaceMatches,
	type MatchOptions,
	type TextMatch
} from '#lib/prose-replace';
import { toLf } from '#lib/line-endings';
import { textHash } from '#lib/text-hash';
import { wordCount } from '#lib/word-count';
import type { StoryFindResult, StoryFindScene, StoryReplaceResult } from '#lib/wire-types';

// Find and replace across a chapter or a whole story. The search lists every
// match with a fingerprint of the text it was found in; the replace takes the
// matches the writer kept, per scene, and writes a scene only while its text
// still has that fingerprint, so nothing typed since the search is replaced
// over. Offsets are into the text with plain newlines, as the editor counts.

// The preview stops listing here; a search this broad should be narrowed.
export const MAX_MATCHES = 1000;

export type ReplaceScope = { storyId: string; chapterId: string | null };

export async function findInStory(
	db: Database,
	scope: ReplaceScope,
	find: string,
	options: MatchOptions
): Promise<StoryFindResult> {
	const rows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			chapterId: scenes.chapterId,
			bodyMd: scenes.bodyMd
		})
		.from(scenes)
		.where(
			and(
				eq(scenes.storyId, scope.storyId),
				isNull(scenes.deletedAt),
				scope.chapterId ? eq(scenes.chapterId, scope.chapterId) : undefined
			)
		)
		.orderBy(asc(scenes.globalPosition));
	const out: StoryFindScene[] = [];
	let matchCount = 0;
	let listed = 0;
	for (const row of rows) {
		const body = toLf(row.bodyMd);
		const matches = findMatches(body, find, options);
		if (matches.length === 0) continue;
		matchCount += matches.length;
		const room = MAX_MATCHES - listed;
		if (room <= 0) continue;
		const shown = matches.slice(0, room);
		listed += shown.length;
		out.push({
			sceneId: row.id,
			title: row.title,
			chapterId: row.chapterId,
			baseHash: textHash(row.bodyMd),
			matches: shown.map((match) => ({ ...match, ...matchContext(body, match) }))
		});
	}
	return { scenes: out, matchCount, truncated: matchCount > listed };
}

export type SceneReplacement = { sceneId: string; baseHash: string; starts: number[] };

export async function replaceInStory(
	db: Database,
	scope: ReplaceScope,
	request: { find: string; replace: string; options: MatchOptions; scenes: SceneReplacement[] }
): Promise<StoryReplaceResult> {
	const { find, replace, options } = request;
	const label = `Replaced "${find}" with "${replace}"`;
	const result: StoryReplaceResult = { scenesChanged: 0, replaced: 0, skipped: [] };
	for (const target of request.scenes) {
		const wanted = new Set(target.starts);
		if (wanted.size === 0) continue;
		// One transaction per scene under its row lock, the order the autosave
		// takes: the text is read again here and never trusted from the search.
		const outcome = await db.transaction(async (tx) => {
			const [scene] = await tx
				.select({ bodyMd: scenes.bodyMd, title: scenes.title, chapterId: scenes.chapterId })
				.from(scenes)
				.where(
					and(
						eq(scenes.id, target.sceneId),
						eq(scenes.storyId, scope.storyId),
						isNull(scenes.deletedAt),
						inLiveStory(scenes.storyId)
					)
				)
				.for('update');
			const changed = { skipped: true as const, reason: 'changed' as const };
			if (!scene) return { ...changed, title: null };
			if (scope.chapterId && scene.chapterId !== scope.chapterId)
				return { ...changed, title: scene.title };
			if (textHash(scene.bodyMd) !== target.baseHash) return { ...changed, title: scene.title };
			const body = toLf(scene.bodyMd);
			const chosen: TextMatch[] = findMatches(body, find, options).filter((match) =>
				wanted.has(match.start)
			);
			if (chosen.length === 0) return { skipped: false as const, count: 0 };
			const markers = (
				await tx
					.select({
						id: sceneMarkers.id,
						anchorStart: sceneMarkers.anchorStart,
						anchorEnd: sceneMarkers.anchorEnd
					})
					.from(sceneMarkers)
					.where(eq(sceneMarkers.sceneId, target.sceneId))
			).filter(
				(marker): marker is { id: string; anchorStart: number; anchorEnd: number } =>
					marker.anchorStart !== null && marker.anchorEnd !== null
			);
			const replaced = replaceMatches(body, chosen, replace, markers);
			// A replacement that leaves the text as it was (only the case
			// differed and match case is off) is not a change.
			if (replaced.body === body) return { skipped: false as const, count: 0 };
			// Past the save limit, every later autosave of the scene would fail.
			if (replaced.body.length > MAX_PROSE_CHARS)
				return { skipped: true as const, title: scene.title, reason: 'too_long' as const };
			// History ends on the text as it was, even for a scene that never
			// went through the editor (an import), so the replace can be undone.
			await recordRevision(tx, 'scene', target.sceneId, scene.bodyMd);
			await tx
				.update(scenes)
				.set({ bodyMd: replaced.body, wordCount: wordCount(replaced.body) })
				.where(eq(scenes.id, target.sceneId));
			// A marker whose whole passage was replaced with nothing has nothing
			// left to point at: detach it, as the autosave's remap does.
			const emptied = replaced.anchors.filter((anchor) => anchor.anchorStart >= anchor.anchorEnd);
			if (emptied.length > 0)
				await tx
					.update(sceneMarkers)
					.set({ anchorStart: null, anchorEnd: null })
					.where(
						inArray(
							sceneMarkers.id,
							emptied.map((anchor) => anchor.id)
						)
					);
			await updateMarkerAnchors(
				tx,
				target.sceneId,
				replaced.anchors.filter((anchor) => anchor.anchorStart < anchor.anchorEnd),
				replaced.body.length
			);
			// A checkpoint, so the replace stands apart in History and never
			// coalesces into surrounding autosaves.
			await recordRevision(tx, 'scene', target.sceneId, replaced.body, 'checkpoint', { label });
			return { skipped: false as const, count: chosen.length };
		});
		if (outcome.skipped) {
			result.skipped.push({
				sceneId: target.sceneId,
				title: outcome.title,
				reason: outcome.reason
			});
			continue;
		}
		if (outcome.count === 0) continue;
		result.scenesChanged += 1;
		result.replaced += outcome.count;
		await queueSceneMentions(target.sceneId);
	}
	return result;
}
