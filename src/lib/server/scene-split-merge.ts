import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { ActionFailure } from './action-result.ts';
import type { Database } from './auth.ts';
import { dbNow } from './db-clock.ts';
import { entityMentions, sceneMarkers, scenes, stories } from './db/schema.ts';
import { recordRevision } from './revisions.ts';
import { keepTimestamps, keepUpdatedAt, ownedScene } from './scene-access.ts';
import { lockStoryScenes } from './row-locks.ts';
import { textHash } from '#lib/text-hash';
import { lfOffset, toLf } from '#lib/line-endings';
import { wordCount } from '#lib/word-count';
import { locateSplitBefore } from '#lib/scene-split-locate';
import { inLiveStory, storyIsLive } from './universe-scope.ts';
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
		// Cut the text as it is under the lock, so an autosave that lands
		// meanwhile is never replaced.
		const scene = await lockStoryScene(tx, owned.storyId, sceneId);
		if (!scene) return GONE;
		// The editor reads \r\n as one newline, so its offset, fingerprint,
		// and marker anchors all count in the newline text; a body imported
		// with \r\n line breaks is cut, and stored, in that text. An offset
		// placed in the stored text itself (the Assistant's) maps across.
		const body = toLf(scene.bodyMd);
		let at: number;
		if (textHash(scene.bodyMd) === expected) {
			at = Number.isInteger(offset) ? lfOffset(scene.bodyMd, offset) : offset;
		} else if (body !== scene.bodyMd && textHash(body) === expected) {
			at = offset;
		} else {
			return {
				ok: false as const,
				code: 'conflict' as const,
				reason: 'The scene changed before it could be split. Check the text and try again.'
			};
		}
		if (!Number.isInteger(at) || at <= 0 || at >= body.length) {
			return {
				ok: false as const,
				code: 'invalid' as const,
				reason: 'Put the cursor inside the text, not at an edge.'
			};
		}

		// Split exactly at the offset for the marker maths, then tidy the seam:
		// the head sheds trailing blank space, the tail its leading blank space.
		const rawHead = body.slice(0, at);
		const rawTail = body.slice(at);
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

		// Markers whose text starts in the second half move with it (one
		// starting in the seam's blank space has none in the first half); one
		// straddling the cut stays behind, clamped to the first half.
		const markers = await tx.select().from(sceneMarkers).where(eq(sceneMarkers.sceneId, scene.id));
		for (const marker of markers) {
			// An unanchored marker has nothing to move with; it stays put.
			if (marker.anchorStart === null || marker.anchorEnd === null) continue;
			if (marker.anchorStart >= head.length) {
				const range = clampAnchors(
					marker.anchorStart - at - tailShift,
					marker.anchorEnd - at - tailShift,
					0,
					tail.length
				);
				await tx
					.update(sceneMarkers)
					.set({ sceneId: created, ...range })
					.where(eq(sceneMarkers.id, marker.id));
			} else if (marker.anchorEnd > head.length) {
				await tx
					.update(sceneMarkers)
					.set({ anchorEnd: head.length })
					.where(eq(sceneMarkers.id, marker.id));
			}
		}

		// Checkpoints, so neither half coalesces into the autosave that holds
		// the text from before the split.
		await recordRevision(tx, 'scene', scene.id, head, 'checkpoint', {
			label: 'Split into two scenes'
		});
		await recordRevision(tx, 'scene', created, tail, 'checkpoint', {
			label: 'Split from the scene before'
		});
		return { ok: true as const, newSceneId: created };
	});
}

const GONE = { ok: false, code: 'not_found', reason: 'That scene no longer exists.' } as const;

// Clamps a marker's range into [lo, hi]. One that covered only blank space
// trimmed away would come out empty, which the editor cannot show; it takes
// the nearest character instead, inside [lo, hi] when there is one and
// otherwise anywhere in a body of `length` (a scene that was all blank).
function clampAnchors(start: number, end: number, lo: number, hi: number, length = hi) {
	let anchorStart = Math.min(Math.max(lo, start), hi);
	let anchorEnd = Math.min(Math.max(anchorStart, end), hi);
	if (anchorEnd === anchorStart) {
		if (anchorStart < hi) anchorEnd = anchorStart + 1;
		else if (anchorStart > lo) anchorStart = anchorStart - 1;
		else if (anchorStart < length) anchorEnd = anchorStart + 1;
		else if (anchorStart > 0) anchorStart = anchorStart - 1;
	}
	return { anchorStart, anchorEnd };
}

// Locks every scene row of the story, then reads the scene. Inserting a scene
// shifts the later ones, so the whole story is held: two paths that add or
// move scenes then take turns rather than handing out the same position.
// Returns null when the scene, or its story, is gone by then.
export async function lockStoryScene(tx: Database, storyId: string, sceneId: string) {
	await lockStoryScenes(tx, storyId);
	// A fresh read, so it sees what a split that held the lock before us did.
	const [scene] = await tx
		.select()
		.from(scenes)
		.where(
			and(
				eq(scenes.id, sceneId),
				eq(scenes.storyId, storyId),
				isNull(scenes.deletedAt),
				inLiveStory(scenes.storyId)
			)
		);
	return scene ?? null;
}

// Inserts a scene directly after `source` (its story's scenes locked by the
// caller), shifting the later scenes of its story and chapter down one. The
// shifted scenes keep both timestamps: the writer did not change them. Returns the new id.
export async function makeRoomAfter(
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
	// Searched with plain newlines, as the editor shows the text, so a passage
	// across a line break is found in a body stored with \r\n. The offset and
	// fingerprint are of that text, which splitScene accepts.
	const needle = toLf(before);
	const body = toLf(scene.bodyMd);
	const here = locateSplitBefore(body, needle);
	if (here.ok) return { ok: true, sceneId, offset: here.offset, baseHash: textHash(body) };
	if (body.includes(needle)) return { ...here, code: 'invalid' };

	const siblings = await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(
			and(eq(scenes.storyId, scene.storyId), isNull(scenes.deletedAt), ne(scenes.id, sceneId))
		);
	const holders = siblings
		.map((sibling) => ({ id: sibling.id, bodyMd: toLf(sibling.bodyMd) }))
		.filter((sibling) => sibling.bodyMd.includes(needle));
	if (holders.length === 0) return { ...here, code: 'invalid' };
	if (holders.length > 1) {
		return {
			ok: false,
			code: 'invalid',
			reason:
				'That text appears in more than one scene; include more surrounding text to make it unique.'
		};
	}
	const there = locateSplitBefore(holders[0].bodyMd, needle);
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
	const owned = await ownedScene(db, userId, sceneId);
	if (!owned) return GONE;

	return await db.transaction(async (tx) => {
		// Copy the source as it is under the lock, so an autosave that lands
		// meanwhile is in the copy.
		const scene = await lockStoryScene(tx, owned.storyId, sceneId);
		if (!scene) return GONE;
		const stamp = await dbNow(tx);

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

		// Marker anchors count each \r\n as one character, as the editor
		// does, so the bodies join, and are stored, with plain newlines.
		const [target, ...rest] = rows;
		const head = toLf(target.bodyMd).replace(/\s+$/, '');
		let merged = head;
		// Where each later scene's text lands in the merged body, for its markers.
		const placed: { id: string; shift: number; lo: number; hi: number }[] = [];
		for (const scene of rest) {
			const base = merged === '' ? 0 : merged.length + 2;
			const body = toLf(scene.bodyMd).replace(/\s+$/, '');
			const lead = body.length - body.replace(/^\s+/, '').length;
			const part = body.slice(lead);
			merged = merged === '' ? part : `${merged}\n\n${part}`;
			placed.push({ id: scene.id, shift: base - lead, lo: base, hi: base + part.length });
		}
		// The target's markers in its trimmed trailing blank space stay on its
		// own text rather than run into the next scene's. Moved first, before
		// the other scenes' markers join it.
		await moveAnchors(tx, target.id, target.id, 0, 0, head.length, merged.length);
		for (const scene of placed) {
			await moveAnchors(tx, scene.id, target.id, scene.shift, scene.lo, scene.hi, merged.length);
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
		// A checkpoint, so it never coalesces into the autosave that holds the
		// target's text from before the merge.
		await recordRevision(tx, 'scene', target.id, merged, 'checkpoint', {
			label: `Merged ${rows.length} scenes`
		});

		// To the trash, like a plain delete: the prose now lives in the
		// target, but the original halves stay restorable. Their mention
		// rows go the way trashScene's do.
		const restIds = rest.map((scene) => scene.id);
		await tx
			.update(scenes)
			.set({ deletedAt: sql`now()`, ...keepUpdatedAt() })
			.where(inArray(scenes.id, restIds));
		await tx
			.delete(entityMentions)
			.where(
				and(eq(entityMentions.sourceType, 'scene'), inArray(entityMentions.sourceId, restIds))
			);
		return { ok: true as const, targetSceneId: target.id };
	});
}

// Moves one scene's anchored markers onto `to`, shifted by `shift` and
// clamped to [lo, hi] of the merged body, `length` characters long.
async function moveAnchors(
	tx: Database,
	from: string,
	to: string,
	shift: number,
	lo: number,
	hi: number,
	length: number
) {
	const markers = await tx
		.select({
			id: sceneMarkers.id,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd
		})
		.from(sceneMarkers)
		.where(and(eq(sceneMarkers.sceneId, from), isNotNull(sceneMarkers.anchorStart)));
	for (const marker of markers) {
		if (marker.anchorStart === null || marker.anchorEnd === null) continue;
		const range = clampAnchors(
			marker.anchorStart + shift,
			marker.anchorEnd + shift,
			lo,
			hi,
			length
		);
		const same = range.anchorStart === marker.anchorStart && range.anchorEnd === marker.anchorEnd;
		if (from === to && same) continue;
		await tx
			.update(sceneMarkers)
			.set({ sceneId: to, ...range })
			.where(eq(sceneMarkers.id, marker.id));
	}
}
