import { describe, it, expect } from 'vitest';
import { badgeBackground, badgeImageSrc } from './entity-badge';
import { entityColor } from './entity-color';

describe('badgeImageSrc', () => {
	it('builds an asset url when a badge image is set', () => {
		expect(badgeImageSrc({ badgeAssetId: 'abc' })).toBe('/assets/abc');
	});
	it('is null with no image', () => {
		expect(badgeImageSrc({ badgeAssetId: null })).toBeNull();
		expect(badgeImageSrc({})).toBeNull();
	});
});

describe('badgeBackground', () => {
	it('prefers the per-entity colour over the category colour', () => {
		expect(
			badgeBackground({
				name: 'Aria',
				badgeColor: 'var(--cat-red)',
				categoryColor: 'var(--cat-blue)'
			})
		).toBe('var(--cat-red)');
	});
	it('falls back to the category colour, then the name hash', () => {
		expect(badgeBackground({ name: 'Aria', categoryColor: 'var(--cat-blue)' })).toBe(
			'var(--cat-blue)'
		);
		expect(badgeBackground({ name: 'Aria' })).toBe(entityColor('Aria'));
	});
});
