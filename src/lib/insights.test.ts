import { describe, it, expect } from 'vitest';
import { addDays, dayAxis, dailyNetWords, streaks } from './insights';

describe('addDays', () => {
	it('crosses month and year boundaries', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
		expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
	});
});

describe('dayAxis', () => {
	it('ends at today, oldest first', () => {
		expect(dayAxis('2026-06-05', 3)).toEqual(['2026-06-03', '2026-06-04', '2026-06-05']);
	});
});

describe('dailyNetWords', () => {
	it('diffs against the baseline from before the window', () => {
		const net = dailyNetWords(
			[{ sceneId: 'a', day: '2026-06-04', words: 1200 }],
			new Map([['a', 1000]])
		);
		expect(net.get('2026-06-04')).toBe(200);
	});

	it('a scene first seen in the window counts from zero', () => {
		const net = dailyNetWords([{ sceneId: 'a', day: '2026-06-04', words: 300 }], new Map());
		expect(net.get('2026-06-04')).toBe(300);
	});

	it('chains day over day within a scene and sums scenes per day', () => {
		const net = dailyNetWords(
			[
				{ sceneId: 'a', day: '2026-06-03', words: 500 },
				{ sceneId: 'a', day: '2026-06-05', words: 800 },
				{ sceneId: 'b', day: '2026-06-05', words: 100 }
			],
			new Map([['a', 200]])
		);
		expect(net.get('2026-06-03')).toBe(300);
		expect(net.get('2026-06-05')).toBe(400);
	});

	it('a trimming day goes negative', () => {
		const net = dailyNetWords(
			[{ sceneId: 'a', day: '2026-06-05', words: 700 }],
			new Map([['a', 1000]])
		);
		expect(net.get('2026-06-05')).toBe(-300);
	});

	it('input order does not matter', () => {
		const net = dailyNetWords(
			[
				{ sceneId: 'a', day: '2026-06-05', words: 800 },
				{ sceneId: 'a', day: '2026-06-03', words: 500 }
			],
			new Map()
		);
		expect(net.get('2026-06-03')).toBe(500);
		expect(net.get('2026-06-05')).toBe(300);
	});
});

describe('streaks', () => {
	it('counts back from today', () => {
		const result = streaks(['2026-06-03', '2026-06-04', '2026-06-05'], '2026-06-05');
		expect(result.current).toBe(3);
		expect(result.longest).toBe(3);
	});

	it('anchors on yesterday when today has no writing yet', () => {
		const result = streaks(['2026-06-03', '2026-06-04'], '2026-06-05');
		expect(result.current).toBe(2);
	});

	it('a gap before yesterday means no current streak', () => {
		const result = streaks(['2026-06-01'], '2026-06-05');
		expect(result.current).toBe(0);
		expect(result.longest).toBe(1);
	});

	it('longest spans an older run', () => {
		const result = streaks(
			['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-06-05'],
			'2026-06-05'
		);
		expect(result.current).toBe(1);
		expect(result.longest).toBe(4);
	});

	it('handles no activity at all', () => {
		expect(streaks([], '2026-06-05')).toEqual({ current: 0, longest: 0 });
	});
});
