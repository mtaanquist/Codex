// Flips the document theme, mirrors it to localStorage so a reload keeps it,
// and (when the viewer is signed in) persists it to the account so the next
// layout-data refresh does not revert it. Returns the theme now in effect.
export function flipTheme(persist: boolean): 'light' | 'dark' {
	const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
	const next = current === 'dark' ? 'light' : 'dark';
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
	return next;
}
