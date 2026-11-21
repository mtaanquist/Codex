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
		expect(message).toMatch(/established voice, tense, and point of view, and consistent/);
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
		expect(message).toMatch(/established voice and tense, and consistent/);
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

	it('sets a scene of a chapter draft in its chapter, after the scene drafted before it', () => {
		const message = buildSceneDraftMessage({
			brief: 'Ilse crosses',
			targetWords: 900,
			chapterBrief: '  Ilse flees with the ledger  ',
			previousDraft: 'She reached the quay.',
			following: { title: 'The Far Bank', text: 'She wakes in the reeds.', kind: 'plan' }
		});
		expect(message).toContain('The writer describes the chapter as:');
		expect(message).toContain('"Ilse flees with the ledger"');
		expect(message).toContain('The scene before this one was just drafted, and reads:');
		expect(message).toContain('She reached the quay.');
		expect(message).toContain('Carry on from where it ends. Do not repeat it.');
		expect(message).toContain('The scene that follows this one ("The Far Bank") is planned as:');
		// The chapter comes first, then what was drafted, then this scene's brief.
		expect(message.indexOf('Ilse flees')).toBeLessThan(message.indexOf('She reached the quay.'));
		expect(message.indexOf('She reached the quay.')).toBeLessThan(
			message.indexOf('"Ilse crosses"')
		);
	});

	it('writes a scene with no brief of its own as its part of the chapter', () => {
		const message = buildSceneDraftMessage({
			brief: '  ',
			targetWords: 900,
			chapterBrief: 'Ilse flees with the ledger'
		});
		expect(message).toContain('as its part of the chapter described above');
		expect(message).not.toContain('to this brief');
		expect(message).not.toContain('""');
	});

	it('says nothing of a chapter or an earlier draft for a scene drafted on its own', () => {
		const message = buildSceneDraftMessage({ brief: 'b', targetWords: 800 });
		expect(message).not.toContain('chapter');
		expect(message).not.toContain('just drafted');
	});
});
