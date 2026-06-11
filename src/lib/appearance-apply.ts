import {
	DEFAULT_ACCENT,
	DEFAULT_SYSTEM_DARK,
	DEFAULT_SYSTEM_LIGHT,
	resolveTheme,
	type ConcreteTheme,
	type Theme
} from './appearance';
import { faviconDataUrl } from './favicon.ts';

// Applies the colour theme and accent to the document, and keeps the
// localStorage keys the app.html pre-paint script reads in sync so the next
// load has no flash. Browser-only; callers guard on `browser`.
export function applyAppearance(
	theme: Theme,
	accent: string,
	systemLight: ConcreteTheme = DEFAULT_SYSTEM_LIGHT,
	systemDark: ConcreteTheme = DEFAULT_SYSTEM_DARK
): void {
	const root = document.documentElement;
	const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	const resolved = resolveTheme(theme, systemLight, systemDark, prefersDark);
	root.setAttribute('data-theme', resolved);

	if (accent && accent !== DEFAULT_ACCENT) {
		root.style.setProperty('--accent', accent);
	} else {
		root.style.removeProperty('--accent');
	}

	// The favicon carries the accent too, so the tab matches the brand mark.
	document.querySelector('link[rel="icon"]')?.setAttribute('href', faviconDataUrl(accent));

	try {
		// 'system' is the absence of a stored theme, matching the pre-paint script.
		if (theme === 'system') localStorage.removeItem('codex-theme');
		else localStorage.setItem('codex-theme', theme);
		// The mappings let the pre-paint script resolve 'system' without a flash.
		if (systemLight !== DEFAULT_SYSTEM_LIGHT)
			localStorage.setItem('codex-system-light', systemLight);
		else localStorage.removeItem('codex-system-light');
		if (systemDark !== DEFAULT_SYSTEM_DARK) localStorage.setItem('codex-system-dark', systemDark);
		else localStorage.removeItem('codex-system-dark');
		if (accent && accent !== DEFAULT_ACCENT) localStorage.setItem('codex-accent', accent);
		else localStorage.removeItem('codex-accent');
	} catch {
		/* preference just does not persist across loads */
	}
}
