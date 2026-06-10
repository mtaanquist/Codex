import { describe, it, expect } from 'vitest';
import { buildReviewReplyMessage, excerptAround } from './review-reply';

describe('excerptAround', () => {
	const body = 'a'.repeat(1000) + 'THE ANCHOR' + 'b'.repeat(1000);

	it('takes the margin around the anchor with ellipses on cut edges', () => {
		const anchor = { start: 1000, end: 1010 };
		const excerpt = excerptAround(body, anchor);
		expect(excerpt).toContain('THE ANCHOR');
		expect(excerpt.startsWith('...')).toBe(true);
		expect(excerpt.endsWith('...')).toBe(true);
		expect(excerpt.length).toBeLessThan(body.length);
	});

	it('omits ellipses at the document edges', () => {
		const excerpt = excerptAround('short text with THE ANCHOR inside', { start: 16, end: 26 });
		expect(excerpt).toBe('short text with THE ANCHOR inside');
	});

	it('falls back to the scene head without an anchor', () => {
		const excerpt = excerptAround(body, null);
		expect(excerpt).toBe(body.slice(0, 1200));
	});
});

describe('buildReviewReplyMessage', () => {
	it('carries the excerpt and the transcript in order', () => {
		const message = buildReviewReplyMessage({
			sceneTitle: 'The Gate',
			excerpt: 'the passage',
			transcript: [
				{ author: 'Muse', body: 'This drags.' },
				{ author: 'Author', body: 'Which part?' }
			],
			suggestion: null
		});
		expect(message).toContain('"The Gate"');
		expect(message).toContain('the passage');
		expect(message.indexOf('Muse: This drags.')).toBeLessThan(
			message.indexOf('Author: Which part?')
		);
		expect(message).toContain('reply_in_thread');
		expect(message).not.toContain('update_suggestion');
	});

	it('includes the pending suggestion and the revise instruction', () => {
		const message = buildReviewReplyMessage({
			sceneTitle: null,
			excerpt: 'x',
			transcript: [{ author: 'Muse', body: 'Tighten this line.' }],
			suggestion: { original: 'old text', replacement: 'new text' }
		});
		expect(message).toContain('this scene');
		expect(message).toContain('- It replaces: old text');
		expect(message).toContain('- With: new text');
		expect(message).toContain('update_suggestion');
	});

	it('marks an empty replacement as a deletion', () => {
		const message = buildReviewReplyMessage({
			sceneTitle: null,
			excerpt: 'x',
			transcript: [],
			suggestion: { original: 'cut me', replacement: '' }
		});
		expect(message).toContain('(deletes the passage)');
	});
});
