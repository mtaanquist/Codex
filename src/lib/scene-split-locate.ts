// Locates a scene-split point from the exact text the new scene should start
// at. The single source of truth for the Assistant's split proposals: the tool
// validates with it when proposing, and the split endpoint re-locates with it
// at confirm time, so edits between the two cannot misplace the cut. The edge
// rules mirror splitScene (scene-split-merge.ts): the offset must sit strictly
// inside the text and both halves must keep some text after the seam trim.

export type SplitLocation = { ok: true; offset: number } | { ok: false; reason: string };

export function locateSplitBefore(bodyMd: string, before: string): SplitLocation {
	if (!before.trim()) {
		return { ok: false, reason: 'Provide the exact text the new scene should start at.' };
	}
	const first = bodyMd.indexOf(before);
	if (first === -1) {
		return { ok: false, reason: 'That exact text was not found in the scene.' };
	}
	if (bodyMd.indexOf(before, first + 1) !== -1) {
		return {
			ok: false,
			reason: 'That text appears more than once; include more surrounding text to make it unique.'
		};
	}
	if (first <= 0) {
		return { ok: false, reason: 'The scene already starts there; pick a point inside the text.' };
	}
	const head = bodyMd.slice(0, first).replace(/\s+$/, '');
	const tail = bodyMd.slice(first).replace(/^\s+/, '');
	if (head === '' || tail === '') {
		return { ok: false, reason: 'Both halves need some text.' };
	}
	return { ok: true, offset: first };
}
