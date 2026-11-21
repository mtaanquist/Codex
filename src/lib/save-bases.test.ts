import { describe, expect, it } from 'vitest';
import { createSaveBases, MAX_BASE_HASHES } from './save-bases';
import { textHash as h } from './text-hash';

describe('save bases', () => {
	it('sends the last answered text and every text whose save is unaccounted for', () => {
		const bases = createSaveBases('a');
		expect(bases.current()).toEqual([h('a')]);
		const first = bases.begin('b');
		expect(first).toEqual({ hash: h('b'), baseHashes: [h('a')] });
		// Still out: the next save says the server may hold either.
		expect(bases.begin('c').baseHashes).toEqual([h('a'), h('b')]);
		expect(bases.unsettled()).toBe(true);
		expect(bases.knows(h('b'))).toBe(true);
		// Answered and stored: it is the base, and no longer a maybe.
		bases.answered(h('b'));
		bases.landed(h('b'));
		expect(bases.current()).toEqual([h('b'), h('c')]);
		bases.answered(h('c'));
		expect(bases.unsettled()).toBe(false);
		expect(bases.knows(h('a'))).toBe(false);
	});

	it('does not count a retry of the same text twice, and keeps the list short', () => {
		const bases = createSaveBases('a');
		bases.begin('b');
		bases.begin('b');
		expect(bases.current()).toEqual([h('a'), h('b')]);
		for (let i = 0; i < 40; i++) bases.begin(`text ${i}`);
		expect(bases.current()).toHaveLength(MAX_BASE_HASHES);
		expect(bases.current()[0]).toBe(h('a'));
		expect(bases.current().at(-1)).toBe(h('text 39'));
	});

	it('starts over from a text the page took from the server', () => {
		const bases = createSaveBases('a');
		bases.begin('b');
		bases.reset('z');
		expect(bases.current()).toEqual([h('z')]);
		expect(bases.unsettled()).toBe(false);
	});
});
