import { describe, it, expect } from 'vitest';
import { parseLinks } from './account';

describe('parseLinks', () => {
	it('parses a JSON string into trimmed label/url pairs', () => {
		const json = JSON.stringify([
			{ label: '  Site  ', url: '  https://example.com  ' },
			{ label: 'Mastodon', url: '@me@social' }
		]);
		expect(parseLinks(json)).toEqual([
			{ label: 'Site', url: 'https://example.com' },
			{ label: 'Mastodon', url: '@me@social' }
		]);
	});

	it('accepts an already-parsed array', () => {
		expect(parseLinks([{ label: 'A', url: 'https://a.test' }])).toEqual([
			{ label: 'A', url: 'https://a.test' }
		]);
	});

	it('drops rows with no address and non-object items', () => {
		const value = [
			{ label: 'empty', url: '   ' },
			'not an object',
			null,
			{ label: 'good', url: 'https://good.test' }
		];
		expect(parseLinks(value)).toEqual([{ label: 'good', url: 'https://good.test' }]);
	});

	it('caps the count at eight and clamps long fields', () => {
		const many = Array.from({ length: 12 }, (_, i) => ({
			label: `l${i}`,
			url: `https://${i}.test`
		}));
		expect(parseLinks(many)).toHaveLength(8);

		const [link] = parseLinks([{ label: 'x'.repeat(200), url: 'y'.repeat(400) }]);
		expect(link.label.length).toBe(60);
		expect(link.url.length).toBe(200);
	});

	it('drops duplicate addresses, keeping the first', () => {
		const value = [
			{ label: 'Site', url: 'https://example.com' },
			{ label: 'Mirror', url: 'https://example.com' },
			{ label: 'Blog', url: 'https://blog.test' }
		];
		expect(parseLinks(value)).toEqual([
			{ label: 'Site', url: 'https://example.com' },
			{ label: 'Blog', url: 'https://blog.test' }
		]);
	});

	it('returns an empty array for invalid input', () => {
		expect(parseLinks('not json')).toEqual([]);
		expect(parseLinks('{"not":"an array"}')).toEqual([]);
		expect(parseLinks(42)).toEqual([]);
		expect(parseLinks(undefined)).toEqual([]);
	});
});
