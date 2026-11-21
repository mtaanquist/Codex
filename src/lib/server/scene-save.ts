import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { scenes } from './db/schema.ts';
import { remapMarkerAnchors, updateMarkerAnchors } from './markers.ts';
import { recordRevision } from './revisions.ts';
import { inLiveStory } from './universe-scope.ts';
import { textHash } from '#lib/text-hash';
import { wordCount } from '#lib/word-count';

export type SceneSave = {
	title: string | null;
	bodyMd: string;
	// Marker anchors as the editor mapped them; null maps the stored ones
	// through the change.
	anchors: { id: string; anchorStart: number; anchorEnd: number }[] | null;
	// Fingerprints of the text the editor last saw. The save goes through only
	// when the stored text matches one of them; null skips the check.
	baseHashes: string[] | null;
	// The writer chose to keep this version over a newer one. The stored text
	// is kept in History first.
	overwrite: boolean;
};

export type SceneSaveResult =
	// bodyChanged is false when the stored text already matched, so the caller
	// can skip the mention rebuild.
	| { ok: true; wordCount: number; bodyChanged: boolean }
	| { ok: false; conflict: { bodyMd: string; title: string | null } }
	| { ok: false; missing: true };

// The autosave write for one scene. The check, the update and the revision
// share one transaction under the scene's row lock, so two tabs cannot
// interleave and History always ends on the stored text. The row lock comes
// before recordRevision's advisory lock, the same order split and merge use:
// both lock their scenes first and work on the text as read under the lock.
export async function saveSceneBody(
	db: Database,
	sceneId: string,
	save: SceneSave
): Promise<SceneSaveResult> {
	return await db.transaction(async (tx) => {
		const [current] = await tx
			.select({ bodyMd: scenes.bodyMd, title: scenes.title })
			.from(scenes)
			// Checked again under the lock: a merge or trash that held it first
			// may have binned the scene since the caller's ownership check.
			.where(and(eq(scenes.id, sceneId), isNull(scenes.deletedAt), inLiveStory(scenes.storyId)))
			.for('update');
		if (!current) return { ok: false as const, missing: true as const };
		const bodyChanged = current.bodyMd !== save.bodyMd;
		if (save.baseHashes && bodyChanged && !save.baseHashes.includes(textHash(current.bodyMd))) {
			return {
				ok: false as const,
				conflict: { bodyMd: current.bodyMd, title: current.title }
			};
		}
		const count = wordCount(save.bodyMd);
		// An idle editor keeps resending the same text. History already ends on
		// it and the anchors have nothing to move through, so only a new title
		// is worth a write.
		if (!bodyChanged) {
			if (current.title !== save.title) {
				// Mentions read only the body, so an index that was current stays
				// current; one already behind keeps its pending rebuild. One
				// database-clock reading for every stamp, as $onUpdate uses for
				// every other save (see db-clock.ts).
				await tx.execute(sql`
					update scenes set
						title = ${save.title},
						updated_at = t.at,
						touched_at = t.at,
						mentions_indexed_at = case
							when scenes.mentions_indexed_at >= scenes.updated_at then t.at
							else scenes.mentions_indexed_at end
					from (select clock_timestamp() as at) as t
					where scenes.id = ${sceneId}
				`);
			}
			return { ok: true as const, wordCount: count, bodyChanged: false };
		}
		if (save.overwrite) {
			await recordRevision(tx, 'scene', sceneId, current.bodyMd, 'checkpoint', {
				label: 'Replaced from another window'
			});
		}
		await tx
			.update(scenes)
			.set({ title: save.title, bodyMd: save.bodyMd, wordCount: count })
			.where(eq(scenes.id, sceneId));
		await recordRevision(tx, 'scene', sceneId, save.bodyMd);
		// A save without anchors (the review centre's) still moves the text
		// under the markers, so map them through the diff instead.
		if (save.anchors) await updateMarkerAnchors(tx, sceneId, save.anchors, save.bodyMd.length);
		else await remapMarkerAnchors(tx, sceneId, current.bodyMd, save.bodyMd);
		return { ok: true as const, wordCount: count, bodyChanged: true };
	});
}
