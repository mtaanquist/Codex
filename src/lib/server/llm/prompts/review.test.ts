import { describe, it, expect } from 'vitest';
import { buildConsistencyMessage, buildReviewMessage } from './review';

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

describe('review categories', () => {
	const scene = { id: 's1', title: 'The Gate' };

	it('an empty category set stays sparing and never mentions a category sweep', () => {
		const message = buildReviewMessage(scene);
		expect(message).toContain('specific and sparing');
		expect(message).not.toContain('do not filter for importance');
	});

	it('every single-category pass forbids filtering and names its categories', () => {
		const mechanics = buildReviewMessage(scene, [], ['mechanics']);
		expect(mechanics).toContain('spelling and grammar pass');
		expect(mechanics).toContain('do not filter for importance');
		expect(mechanics).toContain('comma splices');
		expect(mechanics).not.toContain('filter verbs');

		const prose = buildReviewMessage(scene, [], ['prose']);
		expect(prose).toContain('prose and style pass');
		expect(prose).toContain('filter verbs');
		expect(prose).not.toContain('comma splices');

		const lore = buildReviewMessage(scene, [], ['lore']);
		expect(lore).toContain('lore pass');
		expect(lore).toContain('Continuity');
		expect(lore).not.toContain('comma splices');
	});

	it('a subset names every chosen category and only those', () => {
		const message = buildReviewMessage(scene, [], ['mechanics', 'prose']);
		expect(message).toContain('spelling and grammar and prose and style pass');
		expect(message).toContain('comma splices');
		expect(message).toContain('filter verbs');
		expect(message).not.toContain('Lore: contradictions');
		expect(message).not.toContain('full copyedit');
	});

	it('all three categories is the full pass and drops the sparing instruction', () => {
		const message = buildReviewMessage(scene, [], ['mechanics', 'prose', 'lore']);
		expect(message).toContain('full copyedit pass');
		expect(message).toContain('comma splices');
		expect(message).toContain('filter verbs');
		expect(message).toContain('Lore: contradictions');
		expect(message).not.toContain('specific and sparing');
	});
});

describe('buildConsistencyMessage', () => {
	it('lists every scene with its id and confines the pass to cross-scene issues', () => {
		const message = buildConsistencyMessage([
			{ id: 's1', title: 'The Gate' },
			{ id: 's2', title: null }
		]);
		expect(message).toContain('cross-scene consistency pass');
		expect(message).toContain('do not repeat per-scene notes');
		expect(message).toContain('The Gate (id: s1)');
		expect(message).toContain('Scene 2 (id: s2)');
		expect(message).toContain('only issues that span scenes');
	});
});
