import { describe, it, expect } from 'vitest';
import { isFullReview, parseCategories, REVIEW_CATEGORIES } from './review-shape';

describe('parseCategories', () => {
	it('keeps known categories in canonical order and drops the rest', () => {
		expect(parseCategories(['lore', 'mechanics'])).toEqual(['mechanics', 'lore']);
		expect(parseCategories(['prose', 'nonsense', 'notes'])).toEqual(['prose']);
	});

	it('de-duplicates and tolerates non-arrays', () => {
		expect(parseCategories(['mechanics', 'mechanics'])).toEqual(['mechanics']);
		expect(parseCategories(undefined)).toEqual([]);
		expect(parseCategories('mechanics')).toEqual([]);
		expect(parseCategories(null)).toEqual([]);
	});
});

describe('isFullReview', () => {
	it('is true only when all three categories are present', () => {
		expect(isFullReview([...REVIEW_CATEGORIES])).toBe(true);
		expect(isFullReview(['mechanics', 'prose'])).toBe(false);
		expect(isFullReview([])).toBe(false);
	});
});
