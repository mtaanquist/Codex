import { describe, it, expect } from 'vitest';
import { buildSceneDraftMessage } from './scene-draft';
import { PROSE_FORMAT } from './format';

describe('buildSceneDraftMessage', () => {
	it('carries the brief and the length, and asks for a bare, in-voice scene', () => {
		const message = buildSceneDraftMessage({
			brief: '  Ilse finds the ledger and hides it  ',
			targetWords: 1200
		});
		expect(message).toContain('"Ilse finds the ledger and hides it"');
		expect(message).toContain('about 1200 words');
		expect(message).toContain('whole of the current scene');
		expect(message).toMatch(/established voice and tense, and point of view/);
		expect(message).toMatch(/only the scene/i);
		expect(message.endsWith(PROSE_FORMAT)).toBe(true);
	});

	it('names the point of view when one is given', () => {
		const message = buildSceneDraftMessage({
			brief: 'the crossing',
			targetWords: 800,
			pov: ' Ilse, close third '
		});
		expect(message).toContain('Point of view: Ilse, close third.');
		// The writer's choice stands in for "the established point of view".
		expect(message).not.toMatch(/and point of view/);
	});

	it('leaves the point of view out when it is blank', () => {
		const message = buildSceneDraftMessage({ brief: 'b', targetWords: 800, pov: '  ' });
		expect(message).not.toContain('Point of view:');
	});

	it('continues from prose the scene already has instead of starting over', () => {
		const message = buildSceneDraftMessage({
			brief: 'she reaches the far bank',
			targetWords: 600,
			existingProse: 'The ferry rocked.'
		});
		expect(message).toContain('The ferry rocked.');
		expect(message).toContain('Do not repeat or rewrite what is already there.');
		expect(message).toContain('rest of the current scene');
		expect(message).not.toContain('whole of the current scene');
		expect(message.indexOf('The ferry rocked.')).toBeLessThan(
			message.indexOf('"she reaches the far bank"')
		);
	});

	it('shows the following scene so the draft lands before it', () => {
		const summary = buildSceneDraftMessage({
			brief: 'b',
			targetWords: 800,
			following: { title: 'The Far Bank', text: 'Ilse wakes in the reeds.', kind: 'summary' }
		});
		expect(summary).toContain('The scene that follows this one ("The Far Bank") is summarised as:');
		expect(summary).toContain('Ilse wakes in the reeds.');
		expect(summary).toContain('Do not write the following scene.');

		const opening = buildSceneDraftMessage({
			brief: 'b',
			targetWords: 800,
			following: { title: null, text: 'Reeds, and cold.', kind: 'opening' }
		});
		expect(opening).toContain('The scene that follows this one opens with:');
	});

	it('reads the same with nothing optional as with blanks', () => {
		const bare = buildSceneDraftMessage({ brief: 'b', targetWords: 800 });
		expect(
			buildSceneDraftMessage({
				brief: 'b',
				targetWords: 800,
				pov: null,
				existingProse: '  ',
				following: { title: 'x', text: ' ', kind: 'opening' }
			})
		).toBe(bare);
	});
});
