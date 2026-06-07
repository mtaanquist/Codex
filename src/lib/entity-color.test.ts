import { describe, it, expect } from 'vitest';
import { CATEGORY_COLORS, CATEGORY_PALETTE, entityColor, isCategoryColor } from './entity-color';

describe('CATEGORY_PALETTE', () => {
	it('is derived from CATEGORY_COLORS and holds only var() tokens', () => {
		expect(CATEGORY_PALETTE).toEqual(CATEGORY_COLORS.map((color) => color.token));
		expect(CATEGORY_PALETTE.every((token) => /^var\(--cat-[a-z]+\)$/.test(token))).toBe(true);
		expect(new Set(CATEGORY_PALETTE).size).toBe(CATEGORY_PALETTE.length);
	});
});

describe('isCategoryColor', () => {
	it('accepts null (no colour) and every palette token', () => {
		expect(isCategoryColor(null)).toBe(true);
		for (const token of CATEGORY_PALETTE) {
			expect(isCategoryColor(token)).toBe(true);
		}
	});

	it('rejects hex values, arbitrary CSS, and unknown tokens', () => {
		expect(isCategoryColor('#7d5fe0')).toBe(false);
		expect(isCategoryColor('red')).toBe(false);
		expect(isCategoryColor('var(--cat-chartreuse)')).toBe(false);
		expect(isCategoryColor('')).toBe(false);
	});
});

describe('entityColor', () => {
	it('is deterministic and always returns a palette token', () => {
		const first = entityColor('Alice');
		expect(entityColor('Alice')).toBe(first);
		expect(CATEGORY_PALETTE).toContain(first);
		expect(CATEGORY_PALETTE).toContain(entityColor(''));
	});
});
