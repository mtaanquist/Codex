import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createAutosave,
	keepaliveFits,
	saveFailure,
	UnretryableSaveError,
	type SaveStatus
} from './autosave';

// A controllable save: each call returns a promise the test settles by hand,
// so ordering and failure paths can be driven exactly.
function manualSave() {
	const calls: { keepalive: boolean; resolve: () => void; reject: (err?: unknown) => void }[] = [];
	const save = (opts: { keepalive: boolean }) =>
		new Promise<void>((resolve, reject) => {
			calls.push({ keepalive: opts.keepalive, resolve, reject });
		});
	return { calls, save };
}

// Lets the chained .then callbacks run between manual settlements.
const tick = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('createAutosave', () => {
	it('debounces: one save for a burst of edits, after the pause', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 500, save });
		autosave.schedule();
		vi.advanceTimersByTime(300);
		autosave.schedule();
		vi.advanceTimersByTime(499);
		expect(calls).toHaveLength(0);
		vi.advanceTimersByTime(1);
		await tick();
		expect(calls).toHaveLength(1);
	});

	it('chains saves so an earlier one settles before the next starts', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 100, save });
		autosave.schedule();
		vi.advanceTimersByTime(100);
		await tick();
		expect(calls).toHaveLength(1);
		// A second edit while the first save is still in flight.
		autosave.schedule();
		vi.advanceTimersByTime(100);
		await tick();
		// The second save waits for the first to settle.
		expect(calls).toHaveLength(1);
		calls[0].resolve();
		await tick();
		expect(calls).toHaveLength(2);
	});

	it('flush commits a pending edit at once and resolves when it lands', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 60_000, save });
		autosave.schedule();
		let flushed = false;
		const flushing = autosave.flush().then(() => {
			flushed = true;
		});
		await tick();
		expect(calls).toHaveLength(1);
		expect(flushed).toBe(false);
		calls[0].resolve();
		await flushing;
		expect(flushed).toBe(true);
		expect(autosave.isDirty()).toBe(false);
	});

	it('a failed save restores dirty and reports error', async () => {
		const { calls, save } = manualSave();
		const seen: SaveStatus[] = [];
		const autosave = createAutosave({ debounceMs: 100, save, onStatus: (s) => seen.push(s) });
		autosave.schedule();
		vi.advanceTimersByTime(100);
		await tick();
		calls[0].reject();
		await tick();
		expect(autosave.isDirty()).toBe(true);
		expect(seen).toEqual(['saving', 'error']);
	});

	it('reports saving through a save that was re-dirtied mid-flight', async () => {
		const { calls, save } = manualSave();
		const seen: SaveStatus[] = [];
		const settled = vi.fn();
		const autosave = createAutosave({
			debounceMs: 100,
			save,
			onStatus: (s) => seen.push(s),
			onSettled: settled
		});
		autosave.schedule();
		vi.advanceTimersByTime(100);
		await tick();
		// Another keystroke while the request is in flight.
		autosave.schedule();
		calls[0].resolve();
		await tick();
		// Still "saving": the newer edit's save is queued behind this one.
		expect(seen).toEqual(['saving', 'saving']);
		expect(settled).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		await tick();
		calls[1].resolve();
		await tick();
		expect(seen).toEqual(['saving', 'saving', 'saving', 'saved']);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it('flushOnPageHide fires a keepalive save and restores dirty on failure', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 100, save });
		autosave.flushOnPageHide();
		expect(calls).toHaveLength(0); // nothing pending, nothing sent
		autosave.schedule();
		autosave.flushOnPageHide();
		expect(calls).toHaveLength(1);
		expect(calls[0].keepalive).toBe(true);
		expect(autosave.isDirty()).toBe(false);
		calls[0].reject();
		await tick();
		expect(autosave.isDirty()).toBe(true);
	});

	it('retries a failed save on a growing backoff until it lands', async () => {
		const { calls, save } = manualSave();
		const seen: SaveStatus[] = [];
		const autosave = createAutosave({ debounceMs: 100, save, onStatus: (s) => seen.push(s) });
		autosave.schedule();
		vi.advanceTimersByTime(100);
		await tick();
		calls[0].reject();
		await tick();
		// No keystroke: the retry comes from the timer alone.
		vi.advanceTimersByTime(1999);
		await tick();
		expect(calls).toHaveLength(1);
		vi.advanceTimersByTime(1);
		await tick();
		expect(calls).toHaveLength(2);
		calls[1].reject();
		await tick();
		// The second wait is longer.
		vi.advanceTimersByTime(2000);
		await tick();
		expect(calls).toHaveLength(2);
		vi.advanceTimersByTime(2000);
		await tick();
		expect(calls).toHaveLength(3);
		calls[2].resolve();
		await tick();
		expect(autosave.isDirty()).toBe(false);
		expect(seen.at(-1)).toBe('saved');
		// Nothing more is scheduled once it landed.
		vi.advanceTimersByTime(120_000);
		await tick();
		expect(calls).toHaveLength(3);
	});

	it('does not retry an unretryable refusal, and still reports error', async () => {
		const { calls, save } = manualSave();
		const seen: SaveStatus[] = [];
		const autosave = createAutosave({ debounceMs: 100, save, onStatus: (s) => seen.push(s) });
		autosave.schedule();
		vi.advanceTimersByTime(100);
		await tick();
		calls[0].reject(saveFailure(400));
		await tick();
		vi.advanceTimersByTime(120_000);
		await tick();
		expect(calls).toHaveLength(1);
		expect(autosave.isDirty()).toBe(true);
		expect(seen).toEqual(['saving', 'error']);
	});

	it('does not retry after teardown', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 100, save });
		autosave.schedule();
		void autosave.teardown();
		await tick();
		calls[0].reject();
		await tick();
		vi.advanceTimersByTime(120_000);
		await tick();
		expect(calls).toHaveLength(1);
	});

	it('warns before unload while an edit is unsaved, failed, or in flight', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 100, save });
		const unload = () => {
			const event = new Event('beforeunload', { cancelable: true });
			autosave.warnBeforeUnload(event);
			return event.defaultPrevented;
		};
		expect(unload()).toBe(false);
		autosave.schedule();
		expect(unload()).toBe(true); // pending
		vi.advanceTimersByTime(100);
		await tick();
		expect(unload()).toBe(true); // in flight
		calls[0].reject();
		await tick();
		expect(unload()).toBe(true); // failed
		vi.advanceTimersByTime(2000);
		await tick();
		calls[1].resolve();
		await tick();
		expect(unload()).toBe(false);
	});

	it('flushOnPageHide resends a save that is still in flight', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 100, save });
		autosave.schedule();
		vi.advanceTimersByTime(100);
		await tick();
		// The regular request dies with the page, so the keepalive one carries it.
		autosave.flushOnPageHide();
		expect(calls).toHaveLength(2);
		expect(calls[1].keepalive).toBe(true);
	});

	it('teardown flushes the pending edit and drains the chain', async () => {
		const { calls, save } = manualSave();
		const autosave = createAutosave({ debounceMs: 60_000, save });
		autosave.schedule();
		let done = false;
		const draining = autosave.teardown().then(() => {
			done = true;
		});
		await tick();
		expect(calls).toHaveLength(1);
		expect(calls[0].keepalive).toBe(false);
		calls[0].resolve();
		await draining;
		expect(done).toBe(true);
	});
});

describe('keepaliveFits', () => {
	it('accepts a body under the keepalive cap and refuses one over it', () => {
		expect(keepaliveFits('a'.repeat(1000))).toBe(true);
		expect(keepaliveFits('a'.repeat(70_000))).toBe(false);
	});

	it('measures bytes, not characters', () => {
		// 30k three-byte characters is 90 KB on the wire.
		expect(keepaliveFits('\u2603'.repeat(30_000))).toBe(false);
	});
});

describe('saveFailure', () => {
	it('marks a 4xx refusal unretryable, except 401, 408 and 429', () => {
		for (const status of [400, 403, 404, 413, 422])
			expect(saveFailure(status)).toBeInstanceOf(UnretryableSaveError);
		for (const status of [401, 408, 429, 500, 502, 503])
			expect(saveFailure(status)).not.toBeInstanceOf(UnretryableSaveError);
	});
});
