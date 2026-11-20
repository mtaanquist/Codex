import { describe, expect, it } from 'vitest';
import { MAX_REASON_LENGTH, normaliseReason } from './suggestion-reason';

describe('normaliseReason', () => {
	it('treats a missing or blank reason as none', () => {
		expect(normaliseReason(undefined)).toBeNull();
		expect(normaliseReason('')).toBeNull();
		expect(normaliseReason(' \n\t ')).toBeNull();
	});

	it('keeps a short reason on one line', () => {
		expect(normaliseReason('  Names her.\n\nKeeps it  clear. ')).toBe('Names her. Keeps it clear.');
	});

	it('keeps a reason of exactly the limit whole', () => {
		const text = 'a'.repeat(MAX_REASON_LENGTH);
		expect(normaliseReason(text)).toBe(text);
	});

	it('cuts a long reason at a word, without doubled punctuation', () => {
		const out = normaliseReason('Naming her keeps it clear. '.repeat(20))!;
		expect(Array.from(out).length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
		expect(out.endsWith('...')).toBe(true);
		expect(out).not.toMatch(/[ .]\.\.\.$/);
	});

	it('cuts mid-word when there is no space late enough', () => {
		const out = normaliseReason(`${'x'.repeat(400)}`)!;
		expect(out).toBe(`${'x'.repeat(MAX_REASON_LENGTH - 3)}...`);
	});

	it('never splits an emoji', () => {
		const out = normaliseReason('\u{1F600}'.repeat(400))!;
		expect(out).not.toContain('\uFFFD');
		expect(Array.from(out).length).toBe(MAX_REASON_LENGTH);
	});
});
