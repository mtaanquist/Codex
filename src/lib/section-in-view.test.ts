import { describe, expect, it } from 'vitest';
import { sectionInView } from './section-in-view';

const at = (...tops: number[]) => tops.map((top, i) => ({ id: `s${i}`, top }));

describe('sectionInView', () => {
	it('picks the last section that reached the line', () => {
		expect(sectionInView(at(-400, -20, 300), 80)).toBe('s1');
		expect(sectionInView(at(-400, 80, 300), 80)).toBe('s1');
	});

	it('marks none above the first section', () => {
		expect(sectionInView(at(120, 600), 80)).toBeNull();
		expect(sectionInView([], 80)).toBeNull();
	});
});
