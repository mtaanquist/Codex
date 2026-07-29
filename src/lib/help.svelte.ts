// The help pages are a place, not an overlay: the question mark in the app
// bar navigates to them, lights up while you are there, and takes you back to
// where you were when you press it again. This remembers that location for the
// length of the session.

const state = $state<{ from: string | null }>({ from: null });

export function rememberLocation(url: string): void {
	state.from = url;
}

// Where the lit question mark leads. The fallback covers a reader who opened
// a help page directly, so there is nothing to go back to.
export function helpReturn(fallback: string): string {
	return state.from ?? fallback;
}

// The remembered location itself, or null when help was opened directly.
export function helpFrom(): string | null {
	return state.from;
}
