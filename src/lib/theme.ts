import type { ConcreteTheme } from './appearance';

// The order the theme tool in the app bar walks through. Every shell (author,
// guest, reader) cycles the same three palettes from the same control.
export const THEME_CYCLE: ConcreteTheme[] = ['dark', 'light', 'warm'];

export function currentTheme(): ConcreteTheme {
	const value = document.documentElement.getAttribute('data-theme');
	return value === 'light' || value === 'warm' || value === 'dark' ? value : 'dark';
}

export function nextTheme(theme: ConcreteTheme): ConcreteTheme {
	return THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
}

// Moves the document to the next palette in the cycle, mirrors it to
// localStorage so a reload keeps it, and (when the viewer is signed in)
// persists it to the account. Without the account write the layout re-applies
// the stored appearance on the next data refresh and snaps the theme back, so
// signed-in callers must pass true. Returns the palette now in effect.
export function cycleTheme(persist: boolean): ConcreteTheme {
	const next = nextTheme(currentTheme());
	document.documentElement.setAttribute('data-theme', next);
	try {
		localStorage.setItem('codex-theme', next);
	} catch {
		/* preference just does not persist */
	}
	if (persist) {
		fetch('/api/appearance', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme: next })
		}).catch(() => {
			/* the optimistic change stands; it just will not survive a reload */
		});
	}
	return next;
}
