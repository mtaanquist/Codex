import { describe, it, expect } from 'vitest';
import { relativeTime, storyStatus } from './dashboard';

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
