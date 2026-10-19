import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { scenes } from './db/schema';
import { updateMarkerAnchors } from './markers';
import { recordRevision } from './revisions';
import { textHash } from '$lib/text-hash';
import { wordCount } from '$lib/word-count';

export type SceneSave = {
	title: string | null;
	bodyMd: string;
	// Marker anchors as the editor mapped them; null leaves the stored ones.
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
// before recordRevision's advisory lock, the same order split and merge use.
export async function saveSceneBody(
	db: Database,
	sceneId: string,
	save: SceneSave
): Promise<SceneSaveResult> {
	return await db.transaction(async (tx) => {
		const [current] = await tx
			.select({ bodyMd: scenes.bodyMd, title: scenes.title })
			.from(scenes)
			.where(eq(scenes.id, sceneId))
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
				// current; one already behind keeps its pending rebuild.
				await tx
					.update(scenes)
					.set({
						title: save.title,
						updatedAt: sql`now()`,
						mentionsIndexedAt: sql`case when ${scenes.mentionsIndexedAt} >= ${scenes.updatedAt} then now() else ${scenes.mentionsIndexedAt} end`
					})
					.where(eq(scenes.id, sceneId));
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
		if (save.anchors) await updateMarkerAnchors(tx, sceneId, save.anchors, save.bodyMd.length);
		return { ok: true as const, wordCount: count, bodyChanged: true };
	});
}
