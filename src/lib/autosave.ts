// The debounced, chained autosave queue shared by every editor that persists
// prose (scenes, review edits, entity descriptions, notes). One copy, because
// this is the path the user's words travel: saves are chained so a slow
// earlier request can never land after, and overwrite, a newer one, and a
// failed save restores the dirty flag and retries on a backoff timer, so the
// text is not silently dropped.

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type AutosaveOptions = {
	// How long a pause in typing waits before saving.
	debounceMs: number;
	// Performs one save against the server; resolve means saved, reject means
	// failed (retried later, unless the error is an UnretryableSaveError).
	// keepalive is true only for the page-hide flush, where the request must
	// outlive the page; check the body with keepaliveFits before using it.
	save: (opts: { keepalive: boolean }) => Promise<void>;
	// Save feedback for a status indicator (the app bar's save pill).
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
	// A beforeunload handler: asks the browser to confirm leaving while an edit
	// is unsaved, a save failed, or a save is still on its way.
	warnBeforeUnload: (event: BeforeUnloadEvent | Event) => void;
	// Whether an edit is waiting or a save failed and needs retrying.
	isDirty: () => boolean;
	// Teardown flush for onMount cleanup; resolves when the chain drains.
	teardown: () => Promise<void>;
};

// A save the timer must not repeat, because sending the same text again would
// only fail the same way (a conflict the writer must settle, a refused 4xx).
// The editor still shows the failure, and the next edit tries again.
export class UnretryableSaveError extends Error {}

// The error a save throws for a refused response. A 4xx means this request
// will keep failing (bad input, no access, too large), except 401 (the writer
// may sign in again in another tab), 408 and 429; 5xx is worth retrying.
export function saveFailure(status: number): Error {
	const message = `save failed: ${status}`;
	const retryable = status < 400 || status >= 500 || [401, 408, 429].includes(status);
	return retryable ? new Error(message) : new UnretryableSaveError(message);
}

// Browsers refuse a keepalive request whose body is over 64 KiB (the budget is
// shared by every keepalive request in flight), so a bigger page-hide save has
// to go out as a regular request. Leaves headroom for the other fields.
const KEEPALIVE_MAX_BYTES = 60 * 1024;

export function keepaliveFits(body: string): boolean {
	return new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
}

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60_000;

export function createAutosave(options: AutosaveOptions): Autosave {
	const onStatus = options.onStatus ?? (() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	let inFlight = false;
	let failures = 0;
	let stopped = false;
	let chain: Promise<void> = Promise.resolve();

	async function run(): Promise<void> {
		dirty = false;
		inFlight = true;
		onStatus('saving');
		try {
			await options.save({ keepalive: false });
			failures = 0;
			// A keystroke during the await re-dirtied the doc; another save is
			// already scheduled, so keep showing "saving".
			onStatus(dirty ? 'saving' : 'saved');
			if (!dirty) options.onSettled?.();
		} catch (err) {
			dirty = true;
			onStatus('error');
			if (!stopped && !(err instanceof UnretryableSaveError)) {
				const delay = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS);
				failures++;
				clearTimeout(timer);
				timer = setTimeout(enqueue, delay);
			}
		} finally {
			inFlight = false;
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
			// An in-flight regular request dies with the page, so resend it too.
			if (!dirty && !inFlight) return;
			clearTimeout(timer);
			dirty = false;
			void options.save({ keepalive: true }).catch(() => {
				dirty = true;
			});
		},
		warnBeforeUnload(event) {
			if (dirty || inFlight) event.preventDefault();
		},
		isDirty() {
			return dirty;
		},
		teardown() {
			stopped = true;
			clearTimeout(timer);
			if (dirty) enqueue();
			return chain;
		}
	};
}
