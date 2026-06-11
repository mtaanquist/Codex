import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { entityMentions, sceneMarkers, scenes, stories } from './db/schema';
import { recordRevision } from './revisions';
import { wordCount } from '$lib/word-count';
import { locateSplitBefore } from '$lib/scene-split-locate';

// Splitting and merging scenes. Both run in one transaction and record a
// revision for every body they change; the caller queues the mention
// rebuilds (the queue handle reads $env, which this module must not).

async function ownedLiveScene(db: Database, userId: string, sceneId: string) {
	const [row] = await db
		.select({
			id: scenes.id,
			storyId: scenes.storyId,
			chapterId: scenes.chapterId,
			positionInChapter: scenes.positionInChapter,
			globalPosition: scenes.globalPosition,
			bodyMd: scenes.bodyMd,
			status: scenes.status
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.id, sceneId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)));
	return row ?? null;
}

/**
 * Splits a scene at a character offset, like a page break: everything from
 * the offset on moves into a new untitled scene directly after this one.
 * Markers move with their text; one straddling the cut is clamped to the
 * first half. Returns the new scene's id.
 */
export async function splitScene(
	db: Database,
	userId: string,
	sceneId: string,
	offset: number
): Promise<{ ok: true; newSceneId: string } | { ok: false; reason: string }> {
	const scene = await ownedLiveScene(db, userId, sceneId);
	if (!scene) return { ok: false, reason: 'scene not found' };
	if (!Number.isInteger(offset) || offset <= 0 || offset >= scene.bodyMd.length) {
		return { ok: false, reason: 'put the cursor inside the text, not at an edge' };
	}

	// Split exactly at the offset for the marker maths, then tidy the seam:
	// the head sheds trailing blank space, the tail its leading blank space.
	const rawHead = scene.bodyMd.slice(0, offset);
	const rawTail = scene.bodyMd.slice(offset);
	const head = rawHead.replace(/\s+$/, '');
	const tailShift = rawTail.length - rawTail.replace(/^\s+/, '').length;
	const tail = rawTail.slice(tailShift);
	if (head === '' || tail === '') {
		return { ok: false, reason: 'both halves need some text' };
	}

	const newSceneId = await db.transaction(async (tx) => {
		// Make room directly after the source scene.
		await tx
			.update(scenes)
			.set({ globalPosition: sql`${scenes.globalPosition} + 1` })
			.where(
				and(eq(scenes.storyId, scene.storyId), gt(scenes.globalPosition, scene.globalPosition))
			);
		if (scene.chapterId) {
			await tx
				.update(scenes)
				.set({ positionInChapter: sql`${scenes.positionInChapter} + 1` })
				.where(
					and(
						eq(scenes.chapterId, scene.chapterId),
						gt(scenes.positionInChapter, scene.positionInChapter ?? 0)
					)
				);
		}

		const [created] = await tx
			.insert(scenes)
			.values({
				storyId: scene.storyId,
				chapterId: scene.chapterId,
				positionInChapter: scene.positionInChapter === null ? null : scene.positionInChapter + 1,
				globalPosition: scene.globalPosition + 1,
				title: null,
				bodyMd: tail,
				status: scene.status,
				wordCount: wordCount(tail)
			})
			.returning({ id: scenes.id });

		await tx
			.update(scenes)
			.set({ bodyMd: head, wordCount: wordCount(head) })
			.where(eq(scenes.id, scene.id));

		// Markers from the cut onward move with their text; one straddling
		// the cut stays behind, clamped to the first half.
		const markers = await tx.select().from(sceneMarkers).where(eq(sceneMarkers.sceneId, scene.id));
		for (const marker of markers) {
			// An unanchored marker has nothing to move with; it stays put.
			if (marker.anchorStart === null || marker.anchorEnd === null) continue;
			if (marker.anchorStart >= offset) {
				const start = Math.max(0, marker.anchorStart - offset - tailShift);
				await tx
					.update(sceneMarkers)
					.set({
						sceneId: created.id,
						anchorStart: Math.min(start, tail.length),
						anchorEnd: Math.min(Math.max(start, marker.anchorEnd - offset - tailShift), tail.length)
					})
					.where(eq(sceneMarkers.id, marker.id));
			} else if (marker.anchorEnd > head.length) {
				await tx
					.update(sceneMarkers)
					.set({ anchorEnd: head.length })
					.where(eq(sceneMarkers.id, marker.id));
			}
		}

		await recordRevision(tx, 'scene', scene.id, head);
		await recordRevision(tx, 'scene', created.id, tail);
		return created.id;
	});

	return { ok: true, newSceneId };
}

/**
 * Finds where a proposed split passage lives now. The Assistant's proposals
 * anchor to the scene they were made against, but confirming an earlier
 * proposal moves the later split points into the scene that split created.
 * The passage, not the scene id, is what the writer confirmed, so the locate
 * follows it: when the proposed scene no longer holds the text at all, the
 * one live scene of the story that does is split instead. Any other failure
 * (the text duplicated within the scene, or at its start) keeps its reason.
 */
export async function locateSplitInStory(
	db: Database,
	userId: string,
	sceneId: string,
	before: string
): Promise<{ ok: true; sceneId: string; offset: number } | { ok: false; reason: string }> {
	const scene = await ownedLiveScene(db, userId, sceneId);
	if (!scene) return { ok: false, reason: 'scene not found' };
	const here = locateSplitBefore(scene.bodyMd, before);
	if (here.ok) return { ok: true, sceneId, offset: here.offset };
	if (scene.bodyMd.includes(before)) return here;

	const siblings = await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(
			and(eq(scenes.storyId, scene.storyId), isNull(scenes.deletedAt), ne(scenes.id, sceneId))
		);
	const holders = siblings.filter((sibling) => sibling.bodyMd.includes(before));
	if (holders.length === 0) return here;
	if (holders.length > 1) {
		return {
			ok: false,
			reason:
				'That text appears in more than one scene; include more surrounding text to make it unique.'
		};
	}
	const there = locateSplitBefore(holders[0].bodyMd, before);
	if (!there.ok) return there;
	return { ok: true, sceneId: holders[0].id, offset: there.offset };
}

/**
 * Duplicates a scene as a full copy directly after the original: title (with
 * a "(copy)" suffix), body, status, summary, the planning fields, and every
 * marker, so a scene set up as a template reproduces intact. The body is
 * identical, so marker anchors copy across unchanged. Returns the copy's id.
 */
export async function duplicateScene(
	db: Database,
	userId: string,
	sceneId: string
): Promise<{ ok: true; newSceneId: string } | { ok: false; reason: string }> {
	const [source] = await db
		.select()
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.id, sceneId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)));
	if (!source) return { ok: false, reason: 'scene not found' };
	const scene = source.scenes;

	const newSceneId = await db.transaction(async (tx) => {
		// Make room directly after the source scene, the same shift split uses.
		await tx
			.update(scenes)
			.set({ globalPosition: sql`${scenes.globalPosition} + 1` })
			.where(
				and(eq(scenes.storyId, scene.storyId), gt(scenes.globalPosition, scene.globalPosition))
			);
		if (scene.chapterId) {
			await tx
				.update(scenes)
				.set({ positionInChapter: sql`${scenes.positionInChapter} + 1` })
				.where(
					and(
						eq(scenes.chapterId, scene.chapterId),
						gt(scenes.positionInChapter, scene.positionInChapter ?? 0)
					)
				);
		}

		const [created] = await tx
			.insert(scenes)
			.values({
				storyId: scene.storyId,
				chapterId: scene.chapterId,
				positionInChapter: scene.positionInChapter === null ? null : scene.positionInChapter + 1,
				globalPosition: scene.globalPosition + 1,
				title: scene.title === null ? null : `${scene.title} (copy)`,
				bodyMd: scene.bodyMd,
				povCharacterId: scene.povCharacterId,
				locationId: scene.locationId,
				storyTime: scene.storyTime,
				charactersPresent: scene.charactersPresent,
				status: scene.status,
				summaryMd: scene.summaryMd,
				wordCount: wordCount(scene.bodyMd),
				metadata: scene.metadata
			})
			.returning({ id: scenes.id });

		// The copy's body is identical, so anchors carry over as they are.
		const markers = await tx.select().from(sceneMarkers).where(eq(sceneMarkers.sceneId, scene.id));
		if (markers.length > 0) {
			await tx.insert(sceneMarkers).values(
				markers.map((marker) => ({
					sceneId: created.id,
					ownerId: marker.ownerId,
					kind: marker.kind,
					anchorStart: marker.anchorStart,
					anchorEnd: marker.anchorEnd,
					bodyMd: marker.bodyMd,
					resolvedAt: marker.resolvedAt
				}))
			);
		}

		await recordRevision(tx, 'scene', created.id, scene.bodyMd);
		return created.id;
	});

	return { ok: true, newSceneId };
}

/**
 * Merges two or more scenes into the earliest of them (by story order):
 * bodies join with a blank line between, markers move along with their
 * text, and the merged-away scenes go to the story's trash, restorable
 * like any deleted scene. The first scene keeps its title and status.
 */
export async function mergeScenes(
	db: Database,
	userId: string,
	storyId: string,
	sceneIds: string[]
): Promise<{ ok: true; targetSceneId: string } | { ok: false; reason: string }> {
	const unique = [...new Set(sceneIds)];
	if (unique.length < 2) return { ok: false, reason: 'pick at least two scenes' };

	const rows = await db
		.select({
			id: scenes.id,
			storyId: scenes.storyId,
			bodyMd: scenes.bodyMd,
			globalPosition: scenes.globalPosition
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				inArray(scenes.id, unique),
				eq(scenes.storyId, storyId),
				eq(stories.ownerId, userId),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(scenes.globalPosition));
	if (rows.length !== unique.length) {
		return { ok: false, reason: 'every scene must be a live scene of this story' };
	}

	const [target, ...rest] = rows;
	await db.transaction(async (tx) => {
		let merged = target.bodyMd.replace(/\s+$/, '');
		for (const scene of rest) {
			// Where this scene's text lands in the merged body, for its markers.
			const base = merged === '' ? 0 : merged.length + 2;
			const body = scene.bodyMd.replace(/\s+$/, '');
			const lead = body.length - body.replace(/^\s+/, '').length;
			const part = body.slice(lead);
			merged = merged === '' ? part : `${merged}\n\n${part}`;
			await tx
				.update(sceneMarkers)
				.set({
					sceneId: target.id,
					anchorStart: sql`least(greatest(${sceneMarkers.anchorStart} - ${lead}, 0) + ${base}, ${base + part.length})`,
					anchorEnd: sql`least(greatest(${sceneMarkers.anchorEnd} - ${lead}, 0) + ${base}, ${base + part.length})`
				})
				.where(eq(sceneMarkers.sceneId, scene.id));
		}

		await tx
			.update(scenes)
			.set({ bodyMd: merged, wordCount: wordCount(merged) })
			.where(eq(scenes.id, target.id));
		await recordRevision(tx, 'scene', target.id, merged);

		// To the trash, like a plain delete: the prose now lives in the
		// target, but the original halves stay restorable. Their mention
		// rows go the way trashScene's do.
		const restIds = rest.map((scene) => scene.id);
		await tx
			.update(scenes)
			.set({ deletedAt: sql`now()` })
			.where(inArray(scenes.id, restIds));
		await tx
			.delete(entityMentions)
			.where(
				and(eq(entityMentions.sourceType, 'scene'), inArray(entityMentions.sourceId, restIds))
			);
	});

	return { ok: true, targetSceneId: target.id };
}
