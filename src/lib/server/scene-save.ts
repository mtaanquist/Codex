import { eq } from 'drizzle-orm';
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
	| { ok: true; wordCount: number }
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
		if (save.baseHashes && !save.baseHashes.includes(textHash(current.bodyMd))) {
			if (current.bodyMd !== save.bodyMd) {
				return { ok: false as const, conflict: current };
			}
		}
		if (save.overwrite && current.bodyMd !== save.bodyMd) {
			await recordRevision(tx, 'scene', sceneId, current.bodyMd, 'checkpoint', {
				label: 'Replaced from another window'
			});
		}
		const count = wordCount(save.bodyMd);
		await tx
			.update(scenes)
			.set({ title: save.title, bodyMd: save.bodyMd, wordCount: count })
			.where(eq(scenes.id, sceneId));
		await recordRevision(tx, 'scene', sceneId, save.bodyMd);
		if (save.anchors) await updateMarkerAnchors(tx, sceneId, save.anchors, save.bodyMd.length);
		return { ok: true as const, wordCount: count };
	});
}
