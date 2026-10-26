// WCAG contrast maths for the accent colour. tokens.css derives the filled
// accent (`--accent-fill`) and, in light and warm, the accent text shade
// (`--accent-ink`) with `color-mix(in oklab, var(--accent) 75%, black)`; dark
// uses the raw accent as text. accentFill() reproduces that mix so the account
// page can warn when a custom accent falls below AA somewhere.

export const AA_TEXT = 4.5;
const FILL_SHARE = 0.75;

// The hardest solid surface for accent text on each side: the darkest light
// surface (warm --bg) and the lightest dark one (dark --bg-card). The token
// test checks these against tokens.css.
export const LIGHT_TEXT_FLOOR = '#f3eadd';
export const DARK_TEXT_CEILING = '#17171d';

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
	let h = hex.replace('#', '');
	if (h.length === 3) h = [...h].map((c) => c + c).join('');
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

function toHex(rgb: Rgb): string {
	return (
		'#' +
		rgb
			.map((c) =>
				Math.round(Math.min(1, Math.max(0, c)) * 255)
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function relativeLuminance(hex: string): number {
	const [r, g, b] = parseHex(hex).map(toLinear);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

// Mixes a colour towards black in oklab, as `color-mix(in oklab, c share, black)`.
// Black is the oklab origin, so the mix scales each component.
export function mixWithBlack(hex: string, share: number): string {
	const [r, g, b] = parseHex(hex).map(toLinear);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) * share;
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) * share;
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) * share;
	const [l3, m3, s3] = [l ** 3, m ** 3, s ** 3];
	return toHex(
		[
			4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
			-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
			-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3
		].map(fromLinear) as Rgb
	);
}

export function accentFill(accent: string): string {
	return mixWithBlack(accent, FILL_SHARE);
}

// Why an accent misses AA, or null when it reads everywhere. 'too-light':
// white button text on the fill, or the darkened accent text on the light
// themes. 'too-dark': the raw accent as text on the dark theme.
export function accentProblem(accent: string): 'too-light' | 'too-dark' | null {
	const fill = accentFill(accent);
	if (contrastRatio('#ffffff', fill) < AA_TEXT || contrastRatio(fill, LIGHT_TEXT_FLOOR) < AA_TEXT)
		return 'too-light';
	if (contrastRatio(accent, DARK_TEXT_CEILING) < AA_TEXT) return 'too-dark';
	return null;
}
