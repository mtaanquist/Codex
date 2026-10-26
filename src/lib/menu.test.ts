import { describe, expect, it } from 'vitest';
import { nextIndex } from './menu';

describe('nextIndex', () => {
	it('moves down and wraps to the first item', () => {
		expect(nextIndex(0, 3, 'ArrowDown')).toBe(1);
		expect(nextIndex(2, 3, 'ArrowDown')).toBe(0);
	});

	it('moves up and wraps to the last item', () => {
		expect(nextIndex(1, 3, 'ArrowUp')).toBe(0);
		expect(nextIndex(0, 3, 'ArrowUp')).toBe(2);
	});

	it('starts at the matching end when nothing is focused', () => {
		expect(nextIndex(-1, 3, 'ArrowDown')).toBe(0);
		expect(nextIndex(-1, 3, 'ArrowUp')).toBe(2);
	});

	it('jumps to the ends with Home and End', () => {
		expect(nextIndex(1, 4, 'Home')).toBe(0);
		expect(nextIndex(1, 4, 'End')).toBe(3);
	});

	it('stays on a single item', () => {
		expect(nextIndex(0, 1, 'ArrowDown')).toBe(0);
		expect(nextIndex(0, 1, 'ArrowUp')).toBe(0);
	});

	it('has nowhere to go with no items', () => {
		expect(nextIndex(-1, 0, 'ArrowDown')).toBeNull();
		expect(nextIndex(-1, 0, 'End')).toBeNull();
	});
});
