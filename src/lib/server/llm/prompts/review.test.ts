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

	it('invites a brief positive comment only when there are no prior notes', () => {
		expect(buildReviewMessage({ id: 's1', title: null })).toContain('already strong');
		expect(
			buildReviewMessage({ id: 's1', title: null }, [{ kind: 'comment', body: 'Pacing drags.' }])
		).not.toContain('already strong');
	});

	it('carries open notes and tells the reviewer not to repeat them', () => {
		const message = buildReviewMessage({ id: 's1', title: null }, [
			{ kind: 'comment', body: 'The flashback timing is unclear.' },
			{ kind: 'suggestion', quote: 'the duality of mortals', body: 'the contrast between them' }
		]);
		expect(message).toContain('reviewed this scene before');
		expect(message).toContain('- [comment] The flashback timing is unclear.');
		expect(message).toContain(
			'- [suggested edit] replace "the duality of mortals" with "the contrast between them"'
		);
		expect(message).toContain('Do not repeat or rephrase them');
		expect(message).toContain('If you have nothing new to add, leave no notes.');
	});

	it('clamps long carried notes and collapses their whitespace', () => {
		const body = ('A long observation. ' + 'x'.repeat(400)).split('').join('');
		const message = buildReviewMessage({ id: 's1', title: null }, [
			{ kind: 'comment', body: '  spaced\n\nout   note  ' },
			{ kind: 'comment', body }
		]);
		expect(message).toContain('- [comment] spaced out note');
		const line = message.split('\n').find((l) => l.includes('A long observation.'));
		expect(line).toBeDefined();
		expect(line!.length).toBeLessThan(300);
		expect(line).toContain('...');
	});
});
