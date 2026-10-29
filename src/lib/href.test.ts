import { describe, it, expect } from 'vitest';
import type { ResolvedPathname } from '$app/types';
import { withQuery } from './href';

const path = (p: string) => p as ResolvedPathname;

describe('withQuery', () => {
	it('adds encoded query parameters', () => {
		expect(withQuery(path('/stories/a'), { note: 'x y', from: '/u/b' })).toBe(
			'/stories/a?note=x+y&from=%2Fu%2Fb'
		);
	});

	it('leaves out null, undefined and empty values', () => {
		expect(withQuery(path('/stories/a'), { a: null, b: undefined, c: '', d: 0, e: false })).toBe(
			'/stories/a?d=0&e=false'
		);
	});

	it('returns the path unchanged when nothing is added', () => {
		expect(withQuery(path('/stories/a'), {})).toBe('/stories/a');
	});

	it('extends an existing query string and keeps its hash', () => {
		expect(withQuery(path('/stories/a?view=board#top'), { scene: '7' })).toBe(
			'/stories/a?view=board&scene=7#top'
		);
	});

	it('replaces a parameter that is already there', () => {
		expect(withQuery(path('/stories/a?scene=1'), { scene: '2' })).toBe('/stories/a?scene=2');
	});

	it('sets a hash', () => {
		expect(withQuery(path('/docs/plan'), {}, 'categories')).toBe('/docs/plan#categories');
	});
});
