import { describe, it, expect } from 'vitest';
import { buildContinuationMessage, continuationTail, TAIL_BUDGET_TOKENS } from './continuation';

// The bounds below follow the budget rather than restating it, so recalibrating
// the budget does not fail these tests for the wrong reason.
const MARKER = '[...] ';
const TAIL_CHARS = TAIL_BUDGET_TOKENS * 4;

describe('buildContinuationMessage', () => {
	it('asks for a bare continuation and includes the preceding prose', () => {
		const before = 'The gate of Halden opened the way it always did.';
		const message = buildContinuationMessage(before);
		expect(message).toContain(before);
		expect(message).toMatch(/continuation/i);
		// It must steer away from preamble and repetition.
		expect(message).toMatch(/only the continuation/i);
		expect(message).toMatch(/do not repeat/i);
	});

	it('keeps the instruction lines unchanged when the prose is trimmed', () => {
		const long = 'word '.repeat(40_000);
		const lines = buildContinuationMessage(long).split('\n');
		expect(lines.slice(0, 5)).toEqual([
			'Continue the following prose naturally from exactly where it ends.',
			'Reply with only the continuation: no preamble, no quotation marks, and do not repeat any of the existing text.',
			'Match the established voice and tense. Keep it to a sentence or two unless the passage clearly calls for more.',
			'',
			'---'
		]);
		expect(lines[5]).toMatch(/^\[\.\.\.\] /);
		expect(lines[5].length).toBeLessThanOrEqual(TAIL_CHARS + MARKER.length);
	});
});

describe('continuationTail', () => {
	it('passes short prose through unmarked', () => {
		const before = 'The gate of Halden opened the way it always did.';
		expect(continuationTail(before)).toBe(before);
	});

	it('cuts long prose to the budget and marks the cut', () => {
		const before = 'a'.repeat(500) + ' ' + 'the quick brown fox. '.repeat(2000);
		const tail = continuationTail(before);
		expect(tail.startsWith(MARKER)).toBe(true);
		expect(tail).not.toContain('a'.repeat(500));
		// The budget's worth of prose, plus the marker.
		expect(tail.length).toBeLessThanOrEqual(TAIL_CHARS + MARKER.length);
		expect(before.endsWith(tail.slice(MARKER.length))).toBe(true);
	});

	it('does not open mid-word', () => {
		// A single long run of words with no line breaks, so the cut lands inside
		// one of them.
		const before = 'Halden ' + 'unmistakable '.repeat(2000);
		const tail = continuationTail(before);
		const firstWord = tail.slice(MARKER.length).split(/\s/)[0];
		expect(firstWord).toBe('unmistakable');
	});

	it('keeps a whole word when the cut lands on a boundary', () => {
		// A four-character word divides the budget exactly, so with one word more
		// than the budget holds the cut falls on the space before a whole word.
		const words = TAIL_CHARS / ' abc'.length;
		const before = 'The' + ' abc'.repeat(words + 1);
		const tail = continuationTail(before);
		expect(tail).toBe(MARKER + 'abc' + ' abc'.repeat(words - 1));
	});
});
