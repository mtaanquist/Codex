import { diffChars } from 'diff';

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

	let basePos = 0;
	let currentPos = 0;
	let newStart = -1;
	let newEnd = -1;
	for (const part of diffChars(baseText, currentText)) {
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

// Re-anchors a single position (a pure insertion point). The position
// survives if it lies in or at the boundary of unchanged text.
export function reanchorPoint(
	baseText: string,
	currentText: string,
	position: number
): number | null {
	if (position < 0 || position > baseText.length) return null;
	if (baseText === currentText) return position;

	let basePos = 0;
	let currentPos = 0;
	for (const part of diffChars(baseText, currentText)) {
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
