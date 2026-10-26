import { describe, it, expect } from 'vitest';
import {
	CATEGORY_COLORS,
	CATEGORY_PALETTE,
	entityColor,
	isCategoryColor,
	isCoverColor,
	randomCoverColor,
	storyCoverColor
} from './entity-color';

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

describe('story cover colours', () => {
	it('accepts only palette tokens, never null or arbitrary CSS', () => {
		for (const token of CATEGORY_PALETTE) expect(isCoverColor(token)).toBe(true);
		for (const bad of [null, undefined, '', '#7d5fe0', 'red; background: url(x)', 7]) {
			expect(isCoverColor(bad)).toBe(false);
		}
	});

	it('picks new colours from the palette', () => {
		for (let i = 0; i < 50; i++) expect(isCoverColor(randomCoverColor())).toBe(true);
	});

	it('keeps a stored colour and falls back to a stable pick from the id', () => {
		const id = '0b6f4a52-2f43-4c1e-9d55-2d8a9b5f6c11';
		expect(storyCoverColor({ id, coverColor: 'var(--cat-teal)' })).toBe('var(--cat-teal)');
		const fallback = storyCoverColor({ id, coverColor: null });
		expect(isCoverColor(fallback)).toBe(true);
		expect(storyCoverColor({ id, coverColor: null })).toBe(fallback);
	});
});
