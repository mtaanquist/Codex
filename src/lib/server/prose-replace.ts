import { and, eq, isNull, like } from 'drizzle-orm';
import type { Database } from './auth';
import { sceneMarkers, scenes, stories } from './db/schema';
import { updateMarkerAnchors } from './markers';
import { recordRevision } from './revisions';
import { queueSceneMentions } from './jobs';
import { replaceWholeWord, wholeWordMatches } from '$lib/prose-replace';
import { wordCount } from '$lib/word-count';

// Renaming an entity can sweep the old name out of the prose: count first
// so the offer says what it will touch, then replace with a revision per
// changed scene so it is undoable from History.

function likePattern(find: string): string {
	return `%${find.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// Live scenes in the universe whose prose contains the text at all; the
// whole-word check happens in code on this shortlist.
async function candidateScenes(db: Database, universeId: string, find: string) {
	return await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(stories.universeId, universeId),
				isNull(scenes.deletedAt),
				like(scenes.bodyMd, likePattern(find))
			)
		);
}

export type ProseMatchCount = { scenes: number; occurrences: number };

export async function countProseMatches(
	db: Database,
	universeId: string,
	find: string
): Promise<ProseMatchCount> {
	const rows = await candidateScenes(db, universeId, find);
	let scenesMatched = 0;
	let occurrences = 0;
	for (const row of rows) {
		const found = wholeWordMatches(row.bodyMd, find).length;
		if (found > 0) {
			scenesMatched += 1;
			occurrences += found;
		}
	}
	return { scenes: scenesMatched, occurrences };
}

export async function replaceProse(
	db: Database,
	universeId: string,
	find: string,
	replace: string
): Promise<ProseMatchCount> {
	// The shortlist only names the scenes worth locking; the body is read
	// again under the lock inside each transaction, never trusted from here.
	const rows = await candidateScenes(db, universeId, find);
	let scenesChanged = 0;
	let occurrences = 0;
	for (const row of rows) {
		// Lock the scene row, re-read its current body and markers, and compute
		// and write the replacement all inside one transaction, so an autosave
		// landing between the shortlist read and the write cannot be silently
		// overwritten with stale text. A scene whose prose changed so the word
		// no longer matches is simply skipped.
		const changed = await db.transaction(async (tx) => {
			const [scene] = await tx
				.select({ bodyMd: scenes.bodyMd })
				.from(scenes)
				.where(eq(scenes.id, row.id))
				.for('update');
			if (!scene) return 0;
			// Only anchored markers ride along; detached ones have nothing to move.
			const markers = (
				await tx
					.select({
						id: sceneMarkers.id,
						anchorStart: sceneMarkers.anchorStart,
						anchorEnd: sceneMarkers.anchorEnd
					})
					.from(sceneMarkers)
					.where(eq(sceneMarkers.sceneId, row.id))
			).filter(
				(marker): marker is { id: string; anchorStart: number; anchorEnd: number } =>
					marker.anchorStart !== null && marker.anchorEnd !== null
			);
			const result = replaceWholeWord(scene.bodyMd, find, replace, markers);
			if (result.count === 0) return 0;
			await tx
				.update(scenes)
				.set({ bodyMd: result.body, wordCount: wordCount(result.body) })
				.where(eq(scenes.id, row.id));
			await updateMarkerAnchors(tx, row.id, result.anchors, result.body.length);
			// A checkpoint, so the sweep stands apart in History and never
			// coalesces into surrounding autosaves.
			await recordRevision(tx, 'scene', row.id, result.body, 'checkpoint', {
				label: `Renamed "${find}" to "${replace}"`
			});
			return result.count;
		});
		if (changed === 0) continue;
		scenesChanged += 1;
		occurrences += changed;
		await queueSceneMentions(row.id);
	}
	return { scenes: scenesChanged, occurrences };
}
