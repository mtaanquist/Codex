// The favicon mirrors the topbar brand mark: the white feather on a rounded
// square filled with the accent gradient. One builder produces both the
// static default asset and the data URL that follows a chosen accent, so the
// two cannot drift apart.

import { normaliseAccent } from './appearance.ts';

// The feather paths from Icon.svelte, in its 24x24 viewBox.
const FEATHER = ['M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z', 'M16 8 2 22', 'M17.5 15H9'];

// The gradient's dark stop. The brand mark uses
// color-mix(in oklab, var(--accent) 55%, #000); a plain sRGB scale is close
// enough at favicon size and needs no colour-space maths.
function darkStop(hex: string): string {
	const channels = [1, 3, 5].map((at) => Math.round(parseInt(hex.slice(at, at + 2), 16) * 0.55));
	return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export function faviconSvg(accent: string): string {
	const color = normaliseAccent(accent);
	// Geometry scaled from the 26px brand mark to a 32-unit viewBox: the same
	// corner radius ratio, and the 24-unit feather drawn at the same icon-to-
	// box ratio (15/26). The 140deg gradient line becomes endpoints offset
	// from the centre by (sin 140, -cos 140)/2.
	const paths = FEATHER.map((d) => `<path d="${d}"/>`).join('');
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
		`<defs><linearGradient id="g" x1="18%" y1="12%" x2="82%" y2="88%">` +
		`<stop offset="0" stop-color="${color}"/>` +
		`<stop offset="1" stop-color="${darkStop(color)}"/>` +
		`</linearGradient></defs>` +
		`<rect width="32" height="32" rx="8.5" fill="url(#g)"/>` +
		`<g transform="translate(6.77 6.77) scale(0.77)" fill="none" stroke="#fff" ` +
		`stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</g>` +
		`</svg>`
	);
}

export function faviconDataUrl(accent: string): string {
	return `data:image/svg+xml,${encodeURIComponent(faviconSvg(accent))}`;
}
