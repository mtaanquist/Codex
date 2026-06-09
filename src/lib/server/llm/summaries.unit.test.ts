import { describe, it, expect } from 'vitest';
import { needsSummary } from './summaries';

describe('needsSummary', () => {
	it('fills a blank summary regardless of watermark', () => {
		expect(needsSummary({ summaryMd: null, summaryGeneratedAt: null, changedSince: false })).toBe(
			true
		);
		expect(needsSummary({ summaryMd: '   ', summaryGeneratedAt: null, changedSince: false })).toBe(
			true
		);
	});

	it('never touches a non-blank summary the writer wrote (no watermark)', () => {
		expect(
			needsSummary({ summaryMd: 'Hand written.', summaryGeneratedAt: null, changedSince: true })
		).toBe(false);
	});

	it('refreshes an Assistant-generated summary only when the source changed since', () => {
		const when = new Date('2026-01-01T00:00:00Z');
		expect(needsSummary({ summaryMd: 'Auto.', summaryGeneratedAt: when, changedSince: true })).toBe(
			true
		);
		expect(
			needsSummary({ summaryMd: 'Auto.', summaryGeneratedAt: when, changedSince: false })
		).toBe(false);
	});
});
