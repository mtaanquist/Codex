// Drag-to-resize for the workspace side columns. A chosen width overrides the
// --left-w / --right-w tokens on the root element, so every shell that reads
// them follows, and is kept in localStorage so the app.html pre-paint script
// can restore it without a flash. Widths are per browser, not per account.

export type PaneSide = 'left' | 'right';

// The floors match the tokens' own floors in tokens.css, so a drag never makes
// a column narrower than the default. The caps are shares of the window, so a
// width chosen on a wide screen cannot crowd out the centre on a smaller one.
export const PANE_BOUNDS: Record<PaneSide, { min: number; maxVw: number }> = {
	left: { min: 264, maxVw: 30 },
	right: { min: 312, maxVw: 40 }
};

// Keyboard step for the separator, in pixels.
export const PANE_STEP = 16;

const VAR: Record<PaneSide, string> = { left: '--left-w', right: '--right-w' };
const KEY: Record<PaneSide, string> = { left: 'codex-left-w', right: 'codex-right-w' };

// The largest width the window allows right now.
export function paneMax(side: PaneSide, viewport: number): number {
	const { min, maxVw } = PANE_BOUNDS[side];
	return Math.max(min, Math.floor((viewport * maxVw) / 100));
}

export function clampPaneWidth(side: PaneSide, px: number, viewport: number): number {
	return Math.round(Math.min(Math.max(px, PANE_BOUNDS[side].min), paneMax(side, viewport)));
}

// The token value for a chosen width. CSS clamp keeps the floor and the window
// cap live, so a stored width still fits after the window shrinks. The pre-paint
// script only accepts values of exactly this shape (PANE_VALUE_RE), and takes
// just the chosen width from one: it rebuilds the floor and the cap itself.
export function paneWidthValue(side: PaneSide, px: number): string {
	const { min, maxVw } = PANE_BOUNDS[side];
	return `clamp(${min}px, ${Math.round(px)}px, ${maxVw}vw)`;
}

export const PANE_VALUE_RE = /^clamp\(\d+px, (\d+)px, \d+vw\)$/;

export function setPaneWidth(side: PaneSide, px: number): void {
	const value = paneWidthValue(side, px);
	document.documentElement.style.setProperty(VAR[side], value);
	try {
		localStorage.setItem(KEY[side], value);
	} catch {
		/* the width still applies for this page */
	}
}

// Back to the token's own window-relative default.
export function resetPaneWidth(side: PaneSide): void {
	document.documentElement.style.removeProperty(VAR[side]);
	try {
		localStorage.removeItem(KEY[side]);
	} catch {
		/* nothing stored to clear */
	}
}
