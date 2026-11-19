import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { ActionFailure } from './action-result';
import type { Database } from './auth';
import { entityMentions, sceneMarkers, scenes, stories } from './db/schema';
import { recordRevision } from './revisions';
import { keepTimestamps, keepUpdatedAt, ownedScene } from './scene-access.ts';
import { textHash } from '#lib/text-hash';
import { markChapterSummariesStale, markMentionsStale } from './scene-lifecycle.ts';
import { wordCount } from '#lib/word-count';
import { locateSplitBefore } from '#lib/scene-split-locate';
import { storyIsLive } from './universe-scope.ts';
import { copiedSummaryStamp, summaryIsCurrent } from './summary-currency.ts';

// Splitting and merging scenes. Both run in one transaction and record a
// revision for every body they change; the caller queues the mention
// rebuilds (the queue handle reads $env, which this module must not).

/**
 * Splits a scene at a character offset, like a page break: everything from
 * the offset on moves into a new untitled scene directly after this one.
 * Markers move with their text; one straddling the cut is clamped to the
 * first half. `baseHash` fingerprints the text the offset was placed in;
 * without it, the text as read here stands in. When the stored text differs
 * by the time the scene is locked, nothing is split. Returns the new scene's id.
 */
export async function splitScene(
	db: Database,
	userId: string,
	sceneId: string,
	offset: number,
	baseHash?: string
): Promise<{ ok: true; newSceneId: string } | ActionFailure> {
	const owned = await ownedScene(db, userId, sceneId);
	if (!owned) return GONE;
	const expected = baseHash ?? textHash(owned.bodyMd);

	return await db.transaction(async (tx) => {
		// Lock the scene before anything shifts and cut the text as it is under
		// the lock, so an autosave that lands meanwhile is never replaced.
		const [scene] = await tx
			.select()
			.from(scenes)
			.where(and(eq(scenes.id, sceneId), isNull(scenes.deletedAt)))
			.for('update');
		if (!scene) return GONE;
		if (textHash(scene.bodyMd) !== expected) {
			return {
				ok: false as const,
				code: 'conflict' as const,
				reason: 'The scene changed before it could be split. Check the text and try again.'
			};
		}
		if (!Number.isInteger(offset) || offset <= 0 || offset >= scene.bodyMd.length) {
			return {
				ok: false as const,
				code: 'invalid' as const,
				reason: 'Put the cursor inside the text, not at an edge.'
			};
		}

		// Split exactly at the offset for the marker maths, then tidy the seam:
		// the head sheds trailing blank space, the tail its leading blank space.
		const rawHead = scene.bodyMd.slice(0, offset);
		const rawTail = scene.bodyMd.slice(offset);
		const head = rawHead.replace(/\s+$/, '');
		const tailShift = rawTail.length - rawTail.replace(/^\s+/, '').length;
		const tail = rawTail.slice(tailShift);
		if (head === '' || tail === '') {
			return {
				ok: false as const,
				code: 'invalid' as const,
				reason: 'Both halves need some text.'
			};
		}

		const created = await makeRoomAfter(tx, scene, {
			title: null,
			bodyMd: tail,
			status: scene.status,
			wordCount: wordCount(tail)
		});

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
						sceneId: created,
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
		await recordRevision(tx, 'scene', created, tail);
		return { ok: true as const, newSceneId: created };
	});
}

const GONE = { ok: false, code: 'not_found', reason: 'That scene no longer exists.' } as const;

// Inserts a scene directly after `source` (locked by the caller), shifting
// the later scenes of its story and chapter down one. The shifted scenes keep
// both timestamps: the writer did not change them. Returns the new id.
async function makeRoomAfter(
	tx: Database,
	source: typeof scenes.$inferSelect,
	values: Omit<
		typeof scenes.$inferInsert,
		'storyId' | 'chapterId' | 'positionInChapter' | 'globalPosition'
	>
): Promise<string> {
	await tx
		.update(scenes)
		.set({ globalPosition: sql`${scenes.globalPosition} + 1`, ...keepTimestamps() })
		.where(
			and(eq(scenes.storyId, source.storyId), gt(scenes.globalPosition, source.globalPosition))
		);
	if (source.chapterId) {
		await tx
			.update(scenes)
			.set({ positionInChapter: sql`${scenes.positionInChapter} + 1`, ...keepTimestamps() })
			.where(
				and(
					eq(scenes.chapterId, source.chapterId),
					gt(scenes.positionInChapter, source.positionInChapter ?? 0)
				)
			);
	}
	const [created] = await tx
		.insert(scenes)
		.values({
			...values,
			storyId: source.storyId,
			chapterId: source.chapterId,
			positionInChapter: source.positionInChapter === null ? null : source.positionInChapter + 1,
			globalPosition: source.globalPosition + 1
		})
		.returning({ id: scenes.id });
	return created.id;
}

/**
 * Finds where a proposed split passage lives now. The Assistant's proposals
 * anchor to the scene they were made against, but confirming an earlier
 * proposal moves the later split points into the scene that split created.
 * The passage, not the scene id, is what the writer confirmed, so the locate
 * follows it: when the proposed scene no longer holds the text at all, the
 * one live scene of the story that does is split instead. Any other failure
 * (the text duplicated within the scene, or at its start) keeps its reason.
 * baseHash fingerprints the text the offset is in, for splitScene.
 */
export async function locateSplitInStory(
	db: Database,
	userId: string,
	sceneId: string,
	before: string
): Promise<{ ok: true; sceneId: string; offset: number; baseHash: string } | ActionFailure> {
	const scene = await ownedScene(db, userId, sceneId);
	if (!scene) return { ok: false, code: 'not_found', reason: 'That scene no longer exists.' };
	const here = locateSplitBefore(scene.bodyMd, before);
	if (here.ok) return { ok: true, sceneId, offset: here.offset, baseHash: textHash(scene.bodyMd) };
	if (scene.bodyMd.includes(before)) return { ...here, code: 'invalid' };

	const siblings = await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(
			and(eq(scenes.storyId, scene.storyId), isNull(scenes.deletedAt), ne(scenes.id, sceneId))
		);
	const holders = siblings.filter((sibling) => sibling.bodyMd.includes(before));
	if (holders.length === 0) return { ...here, code: 'invalid' };
	if (holders.length > 1) {
		return {
			ok: false,
			code: 'invalid',
			reason:
				'That text appears in more than one scene; include more surrounding text to make it unique.'
		};
	}
	const there = locateSplitBefore(holders[0].bodyMd, before);
	if (!there.ok) return { ...there, code: 'invalid' };
	return {
		ok: true,
		sceneId: holders[0].id,
		offset: there.offset,
		baseHash: textHash(holders[0].bodyMd)
	};
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
): Promise<{ ok: true; newSceneId: string } | ActionFailure> {
	if (!(await ownedScene(db, userId, sceneId))) return GONE;

	const stamp = new Date();
	return await db.transaction(async (tx) => {
		// Lock the source and copy it as it is under the lock, so an autosave
		// that lands meanwhile is in the copy.
		const [scene] = await tx
			.select()
			.from(scenes)
			.where(and(eq(scenes.id, sceneId), isNull(scenes.deletedAt)))
			.for('update');
		if (!scene) return GONE;

		const created = await makeRoomAfter(tx, scene, {
			title: scene.title === null ? null : `${scene.title} (copy)`,
			bodyMd: scene.bodyMd,
			povCharacterId: scene.povCharacterId,
			locationId: scene.locationId,
			storyTime: scene.storyTime,
			charactersPresent: scene.charactersPresent,
			status: scene.status,
			summaryMd: scene.summaryMd,
			// Whether the Assistant wrote the summary travels with it, and so
			// does whether it was current for this text.
			summaryGeneratedAt: copiedSummaryStamp(
				scene.summaryGeneratedAt,
				summaryIsCurrent(scene.summaryGeneratedAt, scene.updatedAt),
				stamp
			),
			updatedAt: stamp,
			wordCount: wordCount(scene.bodyMd),
			metadata: scene.metadata
		});

		// The copy's body is identical, so anchors carry over as they are.
		const markers = await tx.select().from(sceneMarkers).where(eq(sceneMarkers.sceneId, scene.id));
		if (markers.length > 0) {
			await tx.insert(sceneMarkers).values(
				markers.map((marker) => ({
					sceneId: created,
					ownerId: marker.ownerId,
					kind: marker.kind,
					anchorStart: marker.anchorStart,
					anchorEnd: marker.anchorEnd,
					bodyMd: marker.bodyMd,
					resolvedAt: marker.resolvedAt
				}))
			);
		}

		await recordRevision(tx, 'scene', created, scene.bodyMd);
		// The copy's own summary is current, but its chapter now holds one
		// more scene.
		if (scene.chapterId) await markChapterSummariesStale(tx, [scene.chapterId]);
		return { ok: true as const, newSceneId: created };
	});
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
): Promise<{ ok: true; targetSceneId: string } | ActionFailure> {
	const unique = [...new Set(sceneIds)];
	if (unique.length < 2)
		return { ok: false, code: 'invalid', reason: 'Pick at least two scenes to merge.' };

	const owned = await db
		.select({ id: scenes.id })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				inArray(scenes.id, unique),
				eq(scenes.storyId, storyId),
				eq(stories.ownerId, userId),
				storyIsLive(),
				isNull(scenes.deletedAt)
			)
		);
	const gone = {
		ok: false,
		code: 'not_found',
		reason: 'One of those scenes no longer exists.'
	} as const;
	if (owned.length !== unique.length) return gone;

	return await db.transaction(async (tx) => {
		// Lock the scenes lowest id first and read their bodies under the lock,
		// so an autosave that lands meanwhile is merged in, never replaced.
		const locked = await tx
			.select({
				id: scenes.id,
				storyId: scenes.storyId,
				chapterId: scenes.chapterId,
				bodyMd: scenes.bodyMd,
				globalPosition: scenes.globalPosition,
				deletedAt: scenes.deletedAt
			})
			.from(scenes)
			.where(inArray(scenes.id, unique))
			.orderBy(asc(scenes.id))
			.for('update');
		const rows = locked
			.filter((scene) => scene.storyId === storyId && scene.deletedAt === null)
			.sort((a, b) => a.globalPosition - b.globalPosition);
		if (rows.length !== unique.length) return gone;

		const [target, ...rest] = rows;
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
				.where(and(eq(sceneMarkers.sceneId, scene.id), isNotNull(sceneMarkers.anchorStart)));
			// An unanchored marker has nothing to move with; it changes scene
			// but keeps its null anchors.
			await tx
				.update(sceneMarkers)
				.set({ sceneId: target.id })
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
			.set({ deletedAt: sql`now()`, ...keepUpdatedAt() })
			.where(inArray(scenes.id, restIds));
		await markMentionsStale(tx, { sceneIds: restIds });
		// The merged scenes leave their chapters, even when the target keeps a
		// summary the writer wrote and so is not summarised again.
		const chapterIds = rows.map((scene) => scene.chapterId).filter((id) => id !== null);
		await markChapterSummariesStale(tx, [...new Set(chapterIds)]);
		await tx
			.delete(entityMentions)
			.where(
				and(eq(entityMentions.sourceType, 'scene'), inArray(entityMentions.sourceId, restIds))
			);
		return { ok: true as const, targetSceneId: target.id };
	});
}
