import { describe, it, expect } from 'vitest';
import { recentStories, relativeTime, storyStatus } from './dashboard';

const base = { sceneCount: 4, words: 1000, outline: 0, draft: 0, revised: 0, final: 0 };

describe('storyStatus', () => {
	it('reads as outlining before any prose exists', () => {
		expect(storyStatus({ ...base, sceneCount: 0 }).label).toBe('Outlining');
		expect(storyStatus({ ...base, words: 0, draft: 4 }).label).toBe('Outlining');
	});

	it('takes the most common scene status', () => {
		expect(storyStatus({ ...base, draft: 3, revised: 1 })).toEqual({
			label: 'Drafting',
			token: 'draft'
		});
		expect(storyStatus({ ...base, draft: 1, revised: 3 }).label).toBe('Revising');
	});

	it('gives ties to the later stage', () => {
		expect(storyStatus({ ...base, draft: 2, final: 2 }).label).toBe('Final');
	});
});

describe('relativeTime', () => {
	const now = new Date('2026-06-06T12:00:00Z');
	const ago = (ms: number) => relativeTime(new Date(now.getTime() - ms), now);

	it('walks the ladder', () => {
		expect(ago(30_000)).toBe('just now');
		expect(ago(5 * 60_000)).toBe('5 minutes ago');
		expect(ago(90 * 60_000)).toBe('1 hour ago');
		expect(ago(5 * 3_600_000)).toBe('5 hours ago');
		expect(ago(30 * 3_600_000)).toBe('yesterday');
		expect(ago(6 * 86_400_000)).toBe('6 days ago');
		expect(ago(10 * 86_400_000)).toBe('last week');
		expect(ago(20 * 86_400_000)).toBe('2 weeks ago');
		expect(ago(45 * 86_400_000)).toBe('last month');
		expect(ago(100 * 86_400_000)).toBe('3 months ago');
		expect(ago(400 * 86_400_000)).toBe('last year');
		expect(ago(800 * 86_400_000)).toBe('2 years ago');
	});
});

describe('recentStories', () => {
	const story = (id: string, editedAt: string) => ({ id, editedAt });
	const many = (n: number) =>
		Array.from({ length: n }, (_, i) =>
			story(`s${i}`, new Date(Date.UTC(2026, 0, 1 + i)).toISOString())
		);

	it('is empty while every story fits in the strip', () => {
		expect(recentStories([])).toEqual([]);
		expect(recentStories(many(1))).toEqual([]);
		expect(recentStories(many(3))).toEqual([]);
	});

	it('takes the most recently edited stories, newest first', () => {
		expect(recentStories(many(4)).map((s) => s.id)).toEqual(['s3', 's2', 's1']);
		expect(recentStories(many(10)).map((s) => s.id)).toEqual(['s9', 's8', 's7']);
	});

	it('keeps the input order for ties and leaves the input alone', () => {
		const at = '2026-01-01T00:00:00.000Z';
		const input = [story('a', at), story('b', at), story('c', at), story('d', at)];
		expect(recentStories(input).map((s) => s.id)).toEqual(['a', 'b', 'c']);
		expect(input.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
	});
});
