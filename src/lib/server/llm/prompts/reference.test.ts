import { describe, it, expect } from 'vitest';
import { foldReference, readReference, MAX_REFERENCE_CHARS } from './reference';

const SCENE_ID = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';

describe('readReference', () => {
	it('accepts a uuid scene id and non-empty text', () => {
		expect(readReference({ sceneId: SCENE_ID, text: ' a passage ' })).toEqual({
			sceneId: SCENE_ID,
			text: 'a passage'
		});
	});

	it('rejects garbage', () => {
		expect(readReference(null)).toBeNull();
		expect(readReference('x')).toBeNull();
		expect(readReference({ sceneId: 'not-a-uuid', text: 'a' })).toBeNull();
		expect(readReference({ sceneId: SCENE_ID, text: '   ' })).toBeNull();
		expect(readReference({ sceneId: SCENE_ID, text: 7 })).toBeNull();
	});

	it('truncates an oversized selection instead of rejecting it', () => {
		const text = 'x'.repeat(MAX_REFERENCE_CHARS + 500);
		const reference = readReference({ sceneId: SCENE_ID, text });
		expect(reference!.text).toHaveLength(MAX_REFERENCE_CHARS);
	});
});

describe('foldReference', () => {
	it('quotes the passage and keeps the question after it', () => {
		const folded = foldReference('Why is this tense?', {
			sceneId: SCENE_ID,
			text: 'The rain fell.'
		});
		expect(folded).toContain(`(in scene id ${SCENE_ID})`);
		expect(folded).toContain('> The rain fell.');
		expect(folded.endsWith('Why is this tense?')).toBe(true);
	});

	it('quotes every line of a multi-line passage', () => {
		const folded = foldReference('q', { sceneId: SCENE_ID, text: 'one\ntwo' });
		expect(folded).toContain('> one\n> two');
	});
});
