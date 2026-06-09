import { describe, it, expect } from 'vitest';
import { buildReviewMessage } from './review';

describe('buildReviewMessage', () => {
	it('names the scene and its id, and steers to the staging tools', () => {
		const message = buildReviewMessage({ id: 'scene-123', title: 'The river crossing' });
		expect(message).toContain('The river crossing');
		expect(message).toContain('scene-123');
		expect(message).toContain('suggest_edit');
		expect(message).toContain('leave_comment');
	});

	it('falls back to a generic label for a blank or null title', () => {
		expect(buildReviewMessage({ id: 's1', title: null })).toContain('"this scene"');
		expect(buildReviewMessage({ id: 's1', title: '   ' })).toContain('"this scene"');
	});
});
