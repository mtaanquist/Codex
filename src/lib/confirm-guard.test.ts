import { describe, expect, it } from 'vitest';
import { CONFIRM_SETTLE_MS, createConfirmGuard } from './confirm-guard';

describe('createConfirmGuard', () => {
	it('ignores a press until the cost has been shown for a moment', () => {
		let now = 1000;
		const guard = createConfirmGuard(() => now);
		guard.shown();
		now += 100;
		expect(guard.allows({ detail: 1 })).toBe(false);
		// A key press reports no click count.
		expect(guard.allows({ detail: 0 })).toBe(false);
		now += CONFIRM_SETTLE_MS;
		expect(guard.allows({ detail: 1 })).toBe(true);
		expect(guard.allows({ detail: 0 })).toBe(true);
	});

	it('ignores the later clicks of a multiple click whenever they come', () => {
		let now = 0;
		const guard = createConfirmGuard(() => now);
		guard.shown();
		now += 5000;
		expect(guard.allows({ detail: 2 })).toBe(false);
		expect(guard.allows({ detail: 3 })).toBe(false);
	});

	it('stops a held key from pressing the button again', () => {
		const guard = createConfirmGuard();
		const press = (key: string, repeat: boolean) => {
			let prevented = false;
			guard.keydown({
				key,
				repeat,
				preventDefault: () => (prevented = true)
			} as unknown as KeyboardEvent);
			return prevented;
		};
		expect(press('Enter', true)).toBe(true);
		expect(press(' ', true)).toBe(true);
		expect(press('Enter', false)).toBe(false);
		expect(press('a', true)).toBe(false);
	});
});
