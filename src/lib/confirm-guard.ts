// Guards a button that first shows what an action costs and then, on the next
// press, starts it. The button keeps keyboard focus between the two steps, so
// a double click, a second Enter or a held key would start the action before
// the cost was ever read. The start is ignored until the cost has been on
// screen for a moment, and for any press that is the second of a multiple
// click or a key repeat.

export const CONFIRM_SETTLE_MS = 700;

export type ConfirmGuard = {
	// The cost has just been shown.
	shown: () => void;
	// Whether this press may start the action.
	allows: (event: { detail?: number }) => boolean;
	// For the button's keydown: a held key does not press it again.
	keydown: (event: KeyboardEvent) => void;
};

export function createConfirmGuard(now: () => number = Date.now): ConfirmGuard {
	let shownAt = -Infinity;
	return {
		shown() {
			shownAt = now();
		},
		allows(event) {
			// detail counts the clicks of a multiple click; a key press gives 0.
			if ((event.detail ?? 0) > 1) return false;
			return now() - shownAt >= CONFIRM_SETTLE_MS;
		},
		keydown(event) {
			if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
		}
	};
}
