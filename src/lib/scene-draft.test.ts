import { describe, it, expect } from 'vitest';
import {
	clampDraftWords,
	defaultDraftWords,
	draftExpectedTokens,
	draftMaxTokens,
	FALLBACK_DRAFT_WORDS,
	MAX_DRAFT_WORDS,
	MIN_DRAFT_WORDS,
	wordsForTokens
} from './scene-draft';
import { MAX_REPLY_TOKENS } from './assistant-tuning';

describe('draftMaxTokens', () => {
	it('asks for the target length in tokens plus headroom', () => {
		expect(draftExpectedTokens(1000)).toBe(1400);
		expect(draftMaxTokens(1000)).toBe(1800);
	});

	it('grows with the target length', () => {
		expect(draftMaxTokens(2000)).toBeGreaterThan(draftMaxTokens(1000));
	});

	it('is held to half a known context window', () => {
		expect(draftMaxTokens(3000, 4096)).toBe(2048);
		// A roomy window leaves the figure alone.
		expect(draftMaxTokens(1000, 200_000)).toBe(1800);
	});

	it('never passes the reply length ceiling', () => {
		expect(draftMaxTokens(MAX_DRAFT_WORDS)).toBeLessThanOrEqual(MAX_REPLY_TOKENS);
		expect(draftMaxTokens(1_000_000)).toBe(draftMaxTokens(MAX_DRAFT_WORDS));
	});

	it('stays positive on a tiny window', () => {
		expect(draftMaxTokens(1000, 1)).toBe(1);
	});
});

describe('clampDraftWords', () => {
	it('keeps a length within the limits', () => {
		expect(clampDraftWords(10)).toBe(MIN_DRAFT_WORDS);
		expect(clampDraftWords(1_000_000)).toBe(MAX_DRAFT_WORDS);
		expect(clampDraftWords(1234.4)).toBe(1234);
		expect(clampDraftWords(Number.NaN)).toBe(FALLBACK_DRAFT_WORDS);
	});
});

describe('defaultDraftWords', () => {
	it('falls back when the story has no written scene', () => {
		expect(defaultDraftWords([])).toBe(FALLBACK_DRAFT_WORDS);
		expect(defaultDraftWords([0, 0])).toBe(FALLBACK_DRAFT_WORDS);
	});

	it('takes the median of the written scenes, to the nearest fifty', () => {
		expect(defaultDraftWords([0, 900, 1210, 5000])).toBe(1200);
		expect(defaultDraftWords([1000, 2000])).toBe(1500);
	});

	it('keeps the offer within sensible bounds', () => {
		expect(defaultDraftWords([40])).toBe(300);
		expect(defaultDraftWords([20_000])).toBe(3000);
	});
});

describe('wordsForTokens', () => {
	it('rounds down to fifty words', () => {
		expect(wordsForTokens(900)).toBe(600);
		expect(wordsForTokens(10)).toBe(0);
	});
});
