import { describe, expect, it } from 'vitest';
import { trapTarget } from './modal';

describe('trapTarget', () => {
	it('wraps forwards from the last element to the first', () => {
		expect(trapTarget(2, 3, false)).toBe(0);
	});

	it('wraps backwards from the first element to the last', () => {
		expect(trapTarget(0, 3, true)).toBe(2);
	});

	it('leaves moves in the middle to the browser', () => {
		expect(trapTarget(0, 3, false)).toBeNull();
		expect(trapTarget(2, 3, true)).toBeNull();
	});

	it('enters at the matching end from the panel itself', () => {
		expect(trapTarget(-1, 3, false)).toBe(0);
		expect(trapTarget(-1, 3, true)).toBe(2);
	});

	it('keeps a single element focused', () => {
		expect(trapTarget(0, 1, false)).toBe(0);
		expect(trapTarget(0, 1, true)).toBe(0);
	});

	it('has nothing to move to in an empty dialog', () => {
		expect(trapTarget(-1, 0, false)).toBeNull();
	});
});
