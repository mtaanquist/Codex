// The debounced, chained autosave queue shared by every editor that persists
// prose (scenes, review edits, entity descriptions, notes). One copy, because
// this is the path the user's words travel: saves are chained so a slow
// earlier request can never land after, and overwrite, a newer one, and a
// failed save restores the dirty flag so the text is retried rather than
// silently dropped.

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type AutosaveOptions = {
	// How long a pause in typing waits before saving.
	debounceMs: number;
	// Performs one save against the server; resolve means saved, reject means
	// failed. keepalive is true only for the page-hide flush, where the request
	// must outlive the page (note the keepalive body cap; the debounced saves
	// already covered the text up to the last pause).
	save: (opts: { keepalive: boolean }) => Promise<void>;
	// Save feedback for a status indicator (the TopBar).
	onStatus?: (status: SaveStatus) => void;
	// Runs after a save that succeeded and was not re-dirtied mid-flight; for
	// follow-ups that want settled text (an entity rename offer).
	onSettled?: () => void;
};

export type Autosave = {
	// An edit happened; save after the debounce pause.
	schedule: () => void;
	// Commits a pending edit now and resolves when every queued save landed.
	flush: () => Promise<void>;
	// Commits a pending edit now without waiting (a title field blur).
	flushSoon: () => void;
	// The browser is unloading: fire a keepalive save, since component
	// teardown does not run on unload.
	flushOnPageHide: () => void;
	// Whether an edit is waiting or a save failed and needs retrying.
	isDirty: () => boolean;
	// Teardown flush for onMount cleanup; resolves when the chain drains.
	teardown: () => Promise<void>;
};

export function createAutosave(options: AutosaveOptions): Autosave {
	const onStatus = options.onStatus ?? (() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	let chain: Promise<void> = Promise.resolve();

	async function run(): Promise<void> {
		dirty = false;
		onStatus('saving');
		try {
			await options.save({ keepalive: false });
			// A keystroke during the await re-dirtied the doc; another save is
			// already scheduled, so keep showing "saving".
			onStatus(dirty ? 'saving' : 'saved');
			if (!dirty) options.onSettled?.();
		} catch {
			dirty = true;
			onStatus('error');
		}
	}

	function enqueue() {
		chain = chain.then(run);
	}

	return {
		schedule() {
			dirty = true;
			clearTimeout(timer);
			timer = setTimeout(enqueue, options.debounceMs);
		},
		async flush() {
			clearTimeout(timer);
			if (dirty) enqueue();
			await chain;
		},
		flushSoon() {
			if (!dirty) return;
			clearTimeout(timer);
			enqueue();
		},
		flushOnPageHide() {
			if (!dirty) return;
			clearTimeout(timer);
			dirty = false;
			void options.save({ keepalive: true }).catch(() => {
				dirty = true;
			});
		},
		isDirty() {
			return dirty;
		},
		teardown() {
			clearTimeout(timer);
			if (dirty) enqueue();
			return chain;
		}
	};
}
