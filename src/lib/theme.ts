import type { ConcreteTheme } from './appearance';

function concrete(value: string | null, fallback: ConcreteTheme): ConcreteTheme {
	return value === 'light' || value === 'warm' || value === 'dark' ? value : fallback;
}

// Flips the document between its light and dark sides, resolving the concrete
// palette through the saved system mappings (so the light side can be Warm),
// mirrors it to localStorage so a reload keeps it, and (when the viewer is
// signed in) persists it to the account. Returns the brightness now in effect.
export function flipTheme(persist: boolean): 'light' | 'dark' {
	const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
	const nextBrightness: 'light' | 'dark' = isDark ? 'light' : 'dark';
	let next: ConcreteTheme;
	try {
		next =
			nextBrightness === 'dark'
				? concrete(localStorage.getItem('codex-system-dark'), 'dark')
				: concrete(localStorage.getItem('codex-system-light'), 'light');
	} catch {
		next = nextBrightness;
	}
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
			/* the optimistic flip stands; it just will not survive a reload */
		});
	}
	return nextBrightness;
}
