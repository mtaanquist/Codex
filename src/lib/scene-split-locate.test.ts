import { describe, it, expect } from 'vitest';
import { locateSplitBefore } from './scene-split-locate';

describe('locateSplitBefore', () => {
	const body = 'The first half ends here.\n\nThe second half starts here.';

	it('locates a unique passage', () => {
		const result = locateSplitBefore(body, 'The second half');
		expect(result).toEqual({ ok: true, offset: body.indexOf('The second half') });
	});

	it('rejects empty, missing, and duplicated text', () => {
		expect(locateSplitBefore(body, '  ').ok).toBe(false);
		expect(locateSplitBefore(body, 'not in the scene').ok).toBe(false);
		const dup = locateSplitBefore(body, 'half');
		expect(dup).toMatchObject({ ok: false });
		expect((dup as { reason: string }).reason).toMatch(/more than once/);
	});

	it('rejects a cut at the very start', () => {
		expect(locateSplitBefore(body, 'The first half').ok).toBe(false);
	});

	it('rejects a cut that leaves a blank half, mirroring splitScene', () => {
		// Everything before the match is whitespace, so the head would be empty
		// after the seam trim.
		expect(locateSplitBefore('\n\nOnly half here.', 'Only half').ok).toBe(false);
	});

	it('accepts a cut whose match starts mid-line', () => {
		const result = locateSplitBefore(body, 'second half starts');
		expect(result.ok).toBe(true);
	});
});
