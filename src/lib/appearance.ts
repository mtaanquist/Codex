// Appearance choices shared by the client and the server: the colour theme and
// the accent colour. Kept free of any browser- or server-only imports so both
// the layout that applies them and the account form that saves them can use it.

// A concrete palette applied to the document via the data-theme attribute.
// 'warm' is a warmer light palette alongside the plain 'light'.
export type ConcreteTheme = 'light' | 'warm' | 'dark';
// The account choice: a concrete palette, or 'system' to follow the OS and
// resolve through the two mappings below.
export type Theme = 'system' | ConcreteTheme;

export const THEMES: Theme[] = ['system', 'light', 'warm', 'dark'];
export const DEFAULT_THEME: Theme = 'system';

// The concrete palettes offered for each side of the system preference.
export const LIGHT_THEMES: ConcreteTheme[] = ['light', 'warm'];
export const DARK_THEMES: ConcreteTheme[] = ['dark'];
export const DEFAULT_SYSTEM_LIGHT: ConcreteTheme = 'light';
export const DEFAULT_SYSTEM_DARK: ConcreteTheme = 'dark';

export function isTheme(value: unknown): value is Theme {
	return value === 'system' || value === 'light' || value === 'warm' || value === 'dark';
}

export function isConcreteTheme(value: unknown): value is ConcreteTheme {
	return value === 'light' || value === 'warm' || value === 'dark';
}

// The palette to apply: an explicit choice as-is, or the matching system
// mapping when following the OS. Shared by the client, the pre-paint script's
// logic, and the tests so they never disagree.
export function resolveTheme(
	theme: Theme,
	systemLight: ConcreteTheme,
	systemDark: ConcreteTheme,
	prefersDark: boolean
): ConcreteTheme {
	if (theme !== 'system') return theme;
	return prefersDark ? systemDark : systemLight;
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
