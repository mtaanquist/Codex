import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutosave, type SaveStatus } from './autosave';

// A controllable save: each call returns a promise the test settles by hand,
// so ordering and failure paths can be driven exactly.
function manualSave() {
	const calls: { keepalive: boolean; resolve: () => void; reject: () => void }[] = [];
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
