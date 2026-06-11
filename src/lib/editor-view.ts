// The prose-view toggles (show non-printing marks, hide command markers),
// shared by the Write and Review editors and remembered per user: the flip
// applies at once, and the change persists in the background so the next
// visit opens the same way. Encodes the /api/editor-view contract once.

import type { MarkVisibility } from '$lib/editor';

function persist(patch: { nonPrintingMarks?: string; commandMarkers?: string }) {
	void fetch('/api/editor-view', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch)
	}).catch(() => {});
}

export function toggleNonPrintingMarks(current: MarkVisibility): MarkVisibility {
	const next = current === 'shown' ? 'hidden' : 'shown';
	persist({ nonPrintingMarks: next });
	return next;
}

export function toggleCommandMarkers(current: MarkVisibility): MarkVisibility {
	const next = current === 'shown' ? 'hidden' : 'shown';
	persist({ commandMarkers: next });
	return next;
}
