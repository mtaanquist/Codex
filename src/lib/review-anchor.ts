import { diffChars, type Change } from 'diff';

// Re-anchors a review thread's character range after the text changed.
// Comments pin a [start, end) range against the revision they were made on;
// when the author edits, the range is mapped onto the current text by
// diffing the two versions. Both endpoints must land in unchanged text:
// edits elsewhere shift the range, insertions inside it stretch it, and
// deletions inside it shrink it, but if an endpoint's own text is gone the
// anchor is lost and the thread degrades to a whole-scene comment.
export function reanchorRange(
	baseText: string,
	currentText: string,
	start: number,
	end: number
): { start: number; end: number } | null {
	if (start < 0 || end > baseText.length || start >= end) return null;
	if (baseText === currentText) return { start, end };
	return mapRange(diffChars(baseText, currentText), start, end);
}

// Re-anchors a single position (a pure insertion point). The position
// survives if it lies in or at the boundary of unchanged text.
export function reanchorPoint(
	baseText: string,
	currentText: string,
	position: number
): number | null {
	if (position < 0 || position > baseText.length) return null;
	if (baseText === currentText) return position;
	return mapPoint(diffChars(baseText, currentText), position);
}

function mapRange(
	parts: Change[],
	start: number,
	end: number
): { start: number; end: number } | null {
	let basePos = 0;
	let currentPos = 0;
	let newStart = -1;
	let newEnd = -1;
	for (const part of parts) {
		const length = part.value.length;
		if (part.added) {
			currentPos += length;
			continue;
		}
		if (part.removed) {
			basePos += length;
			continue;
		}
		// Unchanged text: offsets inside it map by the running shift. The end
		// offset is exclusive, so it may land on this part's far boundary.
		if (start >= basePos && start < basePos + length) {
			newStart = currentPos + (start - basePos);
		}
		if (end > basePos && end <= basePos + length) {
			newEnd = currentPos + (end - basePos);
		}
		basePos += length;
		currentPos += length;
	}
	if (newStart === -1 || newEnd === -1 || newEnd <= newStart) return null;
	return { start: newStart, end: newEnd };
}

function mapPoint(parts: Change[], position: number): number | null {
	let basePos = 0;
	let currentPos = 0;
	for (const part of parts) {
		const length = part.value.length;
		if (part.added) {
			currentPos += length;
			continue;
		}
		if (part.removed) {
			basePos += length;
			continue;
		}
		if (position >= basePos && position <= basePos + length) {
			return currentPos + (position - basePos);
		}
		basePos += length;
		currentPos += length;
	}
	return null;
}

// Every thread and suggestion anchored to the same scene revision re-anchors
// against the same two texts, and a character diff of a long scene costs
// hundreds of milliseconds. A mapper diffs each pair of texts once and maps
// every anchor through that one result. Make one per request and hand it to
// everything that re-anchors, so the cost is per revision rather than per
// comment.
export type AnchorMapper = {
	range(
		baseText: string,
		currentText: string,
		start: number,
		end: number
	): { start: number; end: number } | null;
	point(baseText: string, currentText: string, position: number): number | null;
};

export function createAnchorMapper(): AnchorMapper {
	// Nested by base text then current text, so neither key has to be
	// concatenated into a third copy of the scene.
	const cache = new Map<string, Map<string, Change[]>>();
	const diff = (baseText: string, currentText: string): Change[] => {
		let byCurrent = cache.get(baseText);
		if (!byCurrent) {
			byCurrent = new Map();
			cache.set(baseText, byCurrent);
		}
		let parts = byCurrent.get(currentText);
		if (!parts) {
			parts = diffChars(baseText, currentText);
			byCurrent.set(currentText, parts);
		}
		return parts;
	};
	return {
		range(baseText, currentText, start, end) {
			if (start < 0 || end > baseText.length || start >= end) return null;
			if (baseText === currentText) return { start, end };
			return mapRange(diff(baseText, currentText), start, end);
		},
		point(baseText, currentText, position) {
			if (position < 0 || position > baseText.length) return null;
			if (baseText === currentText) return position;
			return mapPoint(diff(baseText, currentText), position);
		}
	};
}
