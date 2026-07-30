import {
	DEFAULT_SYSTEM_DARK,
	DEFAULT_SYSTEM_LIGHT,
	isConcreteTheme,
	resolveTheme,
	type ConcreteTheme
} from './appearance';

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

// Reads a stored appearance key, treating a missing or malformed value as unset.
function storedTheme(key: string, fallback: ConcreteTheme): ConcreteTheme {
	try {
		const value = localStorage.getItem(key);
		return isConcreteTheme(value) ? value : fallback;
	} catch {
		return fallback;
	}
}

// Follows the system palette while the viewer has made no choice of their own on
// this device. The pre-paint script in app.html resolves the same way on load;
// this keeps a page that is already open in step when the system flips, which
// matters most on the reading pages: they belong to the reader, not to us.
// Returns the teardown.
export function followSystemTheme(): () => void {
	const media = window.matchMedia('(prefers-color-scheme: dark)');
	const apply = () => {
		let chosen: string | null = null;
		try {
			chosen = localStorage.getItem('codex-theme');
		} catch {
			/* no choice stored, so the system decides */
		}
		// An explicit choice, from this bar or from the account, always wins.
		if (isConcreteTheme(chosen)) return;
		const resolved = resolveTheme(
			'system',
			storedTheme('codex-system-light', DEFAULT_SYSTEM_LIGHT),
			storedTheme('codex-system-dark', DEFAULT_SYSTEM_DARK),
			media.matches
		);
		document.documentElement.setAttribute('data-theme', resolved);
	};
	media.addEventListener('change', apply);
	return () => media.removeEventListener('change', apply);
}
