import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropAllDraftForms, dropDraftForm, keepDraftForm, readDraftForm } from './draft-forms';

// A small sessionStorage, as the browser gives one.
function fakeStorage(): Storage {
	const held = new Map<string, string>();
	return {
		get length() {
			return held.size;
		},
		key: (i: number) => [...held.keys()][i] ?? null,
		getItem: (key: string) => held.get(key) ?? null,
		setItem: (key: string, value: string) => void held.set(key, value),
		removeItem: (key: string) => void held.delete(key),
		clear: () => held.clear()
	};
}

afterEach(() => {
	dropAllDraftForms();
	vi.unstubAllGlobals();
});

describe('draft forms', () => {
	it('keeps a form for its scene or chapter and drops it', () => {
		vi.stubGlobal('sessionStorage', fakeStorage());
		keepDraftForm('scene', 's1', { brief: 'The ferry.' });
		keepDraftForm('chapter', 's1', { brief: 'The flight.' });
		expect(readDraftForm('scene', 's1')).toEqual({ brief: 'The ferry.' });
		expect(readDraftForm('chapter', 's1')).toEqual({ brief: 'The flight.' });
		expect(readDraftForm('scene', 's2')).toBeUndefined();
		dropDraftForm('scene', 's1');
		expect(readDraftForm('scene', 's1')).toBeUndefined();
		expect(readDraftForm('chapter', 's1')).toEqual({ brief: 'The flight.' });
	});

	it('writes through to the session store, which is what a reload reads', () => {
		const store = fakeStorage();
		vi.stubGlobal('sessionStorage', store);
		keepDraftForm('scene', 's1', { brief: 'The ferry.' });
		expect(JSON.parse(store.getItem('codex.draft-form.scene.s1')!)).toEqual({
			brief: 'The ferry.'
		});
		// Seeded as a reload would find it, with nothing in memory.
		store.setItem('codex.draft-form.scene.s9', JSON.stringify({ brief: 'From before.' }));
		expect(readDraftForm('scene', 's9')).toEqual({ brief: 'From before.' });
	});

	it('clears every form on sign-out and leaves other keys alone', () => {
		const store = fakeStorage();
		vi.stubGlobal('sessionStorage', store);
		store.setItem('something-else', '1');
		keepDraftForm('scene', 's1', { brief: 'a' });
		keepDraftForm('chapter', 'c1', { brief: 'b' });
		dropAllDraftForms();
		expect(readDraftForm('scene', 's1')).toBeUndefined();
		expect(readDraftForm('chapter', 'c1')).toBeUndefined();
		expect(store.length).toBe(1);
		expect(store.getItem('something-else')).toBe('1');
	});

	it('still works when the store throws', () => {
		vi.stubGlobal('sessionStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('full');
			},
			removeItem: () => {
				throw new Error('blocked');
			},
			key: () => null,
			length: 0,
			clear: () => {}
		});
		keepDraftForm('scene', 's1', { brief: 'kept in memory' });
		expect(readDraftForm('scene', 's1')).toEqual({ brief: 'kept in memory' });
		dropDraftForm('scene', 's1');
		expect(readDraftForm('scene', 's1')).toBeUndefined();
		expect(readDraftForm('scene', 'never')).toBeUndefined();
	});
});
