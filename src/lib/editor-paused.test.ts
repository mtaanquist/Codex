import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { landsWhilePaused, pausedExtension } from './editor-paused';

const insert = (paused: boolean) => {
	const state = EditorState.create({ doc: 'Words.', extensions: pausedExtension(paused) });
	return state.update({ changes: { from: 6, insert: ' More.' }, selection: { anchor: 0 } }).state;
};

describe('pausedExtension', () => {
	it('drops edits dispatched while paused, not just typing', () => {
		const state = insert(true);
		expect(state.doc.toString()).toBe('Words.');
		expect(state.readOnly).toBe(true);
	});

	it('lets edits through when not paused', () => {
		expect(insert(false).doc.toString()).toBe('Words. More.');
	});

	it('lets a marked edit through while paused', () => {
		const state = EditorState.create({ doc: 'Words.', extensions: pausedExtension(true) });
		const next = state.update({
			changes: { from: 6, insert: ' Image.' },
			annotations: landsWhilePaused.of(true)
		}).state;
		expect(next.doc.toString()).toBe('Words. Image.');
	});
});
