import { invalidateAll } from '$app/navigation';
import { applyAppearance } from './appearance-apply';
import {
	DEFAULT_ACCENT,
	DEFAULT_SYSTEM_DARK,
	DEFAULT_SYSTEM_LIGHT,
	isConcreteTheme,
	resolveTheme,
	type ConcreteTheme,
	type Theme
} from './appearance';

// The theme picker's choices, in the order it shows them.
export const THEME_CHOICES: { id: Theme; label: string }[] = [
	{ id: 'light', label: 'Light' },
	{ id: 'warm', label: 'Warm' },
	{ id: 'dark', label: 'Dark' },
	{ id: 'system', label: 'System' }
];

// The choice a signed-out viewer made on this device, from the stored
// `codex-theme` value: a palette, or 'system' when none is stored.
export function storedChoice(raw: string | null): Theme {
	return isConcreteTheme(raw) ? raw : 'system';
}

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function deviceChoice(): Theme {
	return storedChoice(readStored('codex-theme'));
}

type SavedAppearance = {
	accent: string;
	systemLightTheme: ConcreteTheme;
	systemDarkTheme: ConcreteTheme;
};

// Saves run one after another, so the last pick is the one the account keeps,
// and only the last refreshes the page data (an earlier refresh would put its
// own choice back on screen while a later save is still on its way).
let saveQueue: Promise<unknown> = Promise.resolve();
let latestSave = 0;

// Applies a theme choice. A signed-in viewer (`saved` is their stored
// appearance) gets it written to the account, then the page data refreshes so
// the layout and the account Display section agree; without the account write
// the layout would re-apply the old choice on the next navigation. A
// signed-out viewer keeps it on this device only.
export async function setTheme(choice: Theme, saved: SavedAppearance | null): Promise<void> {
	if (saved) {
		applyAppearance(choice, saved.accent, saved.systemLightTheme, saved.systemDarkTheme);
		const mine = ++latestSave;
		const save = saveQueue.then(() =>
			fetch('/api/appearance', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ theme: choice })
			}).catch(() => {
				/* a failed save is undone by the refresh below: the account wins */
			})
		);
		saveQueue = save;
		await save;
		if (mine === latestSave) await invalidateAll();
		return;
	}
	applyAppearance(
		choice,
		readStored('codex-accent') ?? DEFAULT_ACCENT,
		storedTheme('codex-system-light', DEFAULT_SYSTEM_LIGHT),
		storedTheme('codex-system-dark', DEFAULT_SYSTEM_DARK)
	);
}

// Reads a stored appearance key, treating a missing or malformed value as unset.
function storedTheme(key: string, fallback: ConcreteTheme): ConcreteTheme {
	const value = readStored(key);
	return isConcreteTheme(value) ? value : fallback;
}

// Follows the system palette while the viewer has made no choice of their own on
// this device. The pre-paint script in app.html resolves the same way on load;
// this keeps a page that is already open in step when the system flips, which
// matters most on the reading pages: they belong to the reader, not to us.
// Returns the teardown.
export function followSystemTheme(): () => void {
	const media = window.matchMedia('(prefers-color-scheme: dark)');
	const apply = () => {
		// An explicit choice, from the picker or from the account, always wins.
		if (isConcreteTheme(readStored('codex-theme'))) return;
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
