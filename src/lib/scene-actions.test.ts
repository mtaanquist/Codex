import { describe, expect, it } from 'vitest';
import { flushEditors, type FlushableEditor } from './scene-actions';

// An editor whose saves succeed after `failures` attempts fail.
function editor(failures = 0, dirty = true) {
	let flushes = 0;
	let pending = dirty;
	const e: FlushableEditor & { flushes: () => number } = {
		async flushSave() {
			flushes++;
			if (pending && flushes > failures) pending = false;
		},
		isDirty: () => pending,
		flushes: () => flushes
	};
	return e;
}

describe('flushEditors', () => {
	it('is true when every pending save lands', async () => {
		const a = editor();
		const b = editor(0, false);
		expect(await flushEditors([a, b])).toBe(true);
		expect(a.isDirty()).toBe(false);
	});

	it('is true with no open editor', async () => {
		expect(await flushEditors([])).toBe(true);
	});

	it('is false when a save still fails, so the caller must not go ahead', async () => {
		const failing = editor(5);
		expect(await flushEditors([editor(), failing])).toBe(false);
		expect(failing.isDirty()).toBe(true);
	});

	it('flushes a still-dirty editor a second time', async () => {
		const late = editor(1);
		expect(await flushEditors([late])).toBe(true);
		expect(late.flushes()).toBe(2);
	});
});
