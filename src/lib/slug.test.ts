import { describe, it, expect } from 'vitest';
import { isUuid, isValidSlug, slugify, SLUG_MAX } from './slug';

describe('slugify', () => {
	it('lowercases and hyphenates', () => {
		expect(slugify('The Toll', 'story')).toBe('the-toll');
		expect(slugify('  Ardenfall:  Book One!  ', 'story')).toBe('ardenfall-book-one');
	});

	it('folds accented letters to their base form', () => {
		expect(slugify('Eressëa', 'universe')).toBe('eressea');
		expect(slugify('Çatal Höyük', 'place')).toBe('catal-hoyuk');
	});

	it('falls back when nothing survives', () => {
		expect(slugify('***', 'story')).toBe('story');
		expect(slugify(null, 'story')).toBe('story');
	});

	it('caps the length without a trailing hyphen', () => {
		const slug = slugify(`${'a'.repeat(SLUG_MAX - 1)} b`, 'x');
		expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
		expect(slug.endsWith('-')).toBe(false);
	});
});

describe('isUuid', () => {
	it('matches the canonical shape only', () => {
		expect(isUuid('8f3a1c2e-1234-4abc-9def-001122334455')).toBe(true);
		expect(isUuid('the-toll')).toBe(false);
		expect(isUuid('8f3a1c2e-1234-4abc-9def-00112233445')).toBe(false);
	});
});

describe('isValidSlug', () => {
	it('accepts canonical slugs', () => {
		expect(isValidSlug('the-toll')).toBe(true);
		expect(isValidSlug('a')).toBe(true);
		expect(isValidSlug('book-2')).toBe(true);
	});

	it('rejects bad shapes', () => {
		expect(isValidSlug('')).toBe(false);
		expect(isValidSlug('-leading')).toBe(false);
		expect(isValidSlug('trailing-')).toBe(false);
		expect(isValidSlug('Upper')).toBe(false);
		expect(isValidSlug('two words')).toBe(false);
		expect(isValidSlug('a'.repeat(SLUG_MAX + 1))).toBe(false);
	});

	it('rejects uuid-shaped slugs so ids cannot be shadowed', () => {
		expect(isValidSlug('8f3a1c2e-1234-4abc-9def-001122334455')).toBe(false);
	});
});
