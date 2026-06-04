// Appearance choices shared by the client and the server: the colour theme and
// the accent colour. Kept free of any browser- or server-only imports so both
// the layout that applies them and the account form that saves them can use it.

export type Theme = 'system' | 'light' | 'dark';

export const THEMES: Theme[] = ['system', 'light', 'dark'];
export const DEFAULT_THEME: Theme = 'system';

export function isTheme(value: unknown): value is Theme {
	return value === 'system' || value === 'light' || value === 'dark';
}

// The accent presets offered as swatches, matching the design. A custom colour
// picker covers anything outside this set.
export const ACCENT_PRESETS: { name: string; value: string }[] = [
	{ name: 'Periwinkle', value: '#5b8cff' },
	{ name: 'Sage', value: '#2fae8c' },
	{ name: 'Amber', value: '#c8924a' },
	{ name: 'Iris', value: '#9b7bff' },
	{ name: 'Rose', value: '#d4708a' },
	{ name: 'Clay', value: '#cf7a52' }
];

// The :root default in tokens.css; storing this is the same as storing nothing.
export const DEFAULT_ACCENT = '#5b8cff';

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isAccentColor(value: unknown): value is string {
	return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

// Normalises an accent to lowercase six-digit hex, or the default when the
// input is not a colour we recognise.
export function normaliseAccent(value: unknown): string {
	if (!isAccentColor(value)) return DEFAULT_ACCENT;
	const hex = value.toLowerCase();
	if (hex.length === 4) {
		return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
	}
	return hex;
}
