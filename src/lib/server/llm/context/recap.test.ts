import { describe, it, expect } from 'vitest';
import { fitRecapScenes } from './assemble';
import type { RecapScene } from './sources';

function scene(over: Partial<RecapScene>): RecapScene {
	return { id: 'x', title: null, summaryMd: null, bodyMd: '', status: 'draft', ...over };
}

describe('fitRecapScenes', () => {
	it('keeps chronological order in the output', () => {
		const scenes = [
			scene({ title: 'One', summaryMd: 'first' }),
			scene({ title: 'Two', summaryMd: 'second' }),
			scene({ title: 'Three', summaryMd: 'third' })
		];
		const { blocks, dropped } = fitRecapScenes(scenes);
		expect(dropped).toBe(0);
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toContain('One');
		expect(blocks[2]).toContain('Three');
	});

	it('prefers a summary over the body, and excerpts a long body', () => {
		const long = 'word '.repeat(2000);
		const withSummary = fitRecapScenes([scene({ summaryMd: 'short summary', bodyMd: long })]);
		expect(withSummary.blocks[0]).toContain('short summary');
		expect(withSummary.blocks[0]).not.toContain('word word');

		const bodyOnly = fitRecapScenes([scene({ bodyMd: long })]);
		expect(bodyOnly.blocks[0]).toMatch(/\[\.\.\.\]$/);
	});

	it('drops the oldest scenes first under a tight budget but keeps the newest', () => {
		const scenes = Array.from({ length: 6 }, (_, i) =>
			scene({ title: `Scene ${i}`, bodyMd: 'body '.repeat(400) })
		);
		const { blocks, dropped } = fitRecapScenes(scenes, 1200);
		expect(dropped).toBeGreaterThan(0);
		// The most recent scene survives, the first does not.
		expect(blocks.at(-1)).toContain('Scene 5');
		expect(blocks.some((b) => b.includes('Scene 0'))).toBe(false);
		// What remains is still in order.
		expect(blocks).toEqual([...blocks].sort());
	});

	it('always keeps the most recent scene even if it alone exceeds budget', () => {
		const { blocks, dropped } = fitRecapScenes(
			[scene({ title: 'Huge', bodyMd: 'x '.repeat(5000) })],
			10
		);
		expect(blocks).toHaveLength(1);
		expect(dropped).toBe(0);
	});
});
