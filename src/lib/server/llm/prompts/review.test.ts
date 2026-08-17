import { describe, it, expect } from 'vitest';
import {
	buildConfirmMessage,
	buildReviewMessage,
	buildSurveyMessage,
	parseCandidates,
	splitSurveyChunks,
	type SurveyScene
} from './review';

describe('buildReviewMessage', () => {
	it('names the scene and its id, and steers to the staging tools', () => {
		const message = buildReviewMessage({ id: 'scene-123', title: 'The river crossing' });
		expect(message).toContain('The river crossing');
		expect(message).toContain('scene-123');
		expect(message).toContain('suggest_edit');
		expect(message).toContain('leave_comment');
	});

	it('tells the reviewer to read the scene when its text is not in the message', () => {
		const message = buildReviewMessage({ id: 's1', title: null });
		expect(message).toContain('Read it in full with get_scene');
		expect(message).not.toContain('Do not call get_scene');
	});

	it('forbids a re-read when the scene text rides in the message', () => {
		const message = buildReviewMessage({ id: 's1', title: null }, [], [], true);
		expect(message).toContain("The scene's full text is already in this message.");
		expect(message).toContain('Do not call get_scene');
		expect(message).not.toContain('Read it in full with get_scene');
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

const surveyScene = (over: Partial<SurveyScene> = {}): SurveyScene => ({
	id: 's1',
	title: 'The Gate',
	summaryMd: null,
	bodyMd: '',
	...over
});

describe('buildSurveyMessage', () => {
	it('lists the scenes in order with their summaries and asks for a JSON array', () => {
		const message = buildSurveyMessage(
			[
				surveyScene({ id: 's1', summaryMd: 'She crosses the river.' }),
				surveyScene({ id: 's2', title: null, summaryMd: 'He waits at the ford.' })
			],
			{ scope: 'story' }
		);
		expect(message).toContain('survey stage');
		expect(message).toContain('The Gate (id: s1): She crosses the river.');
		expect(message).toContain('Scene 2 (id: s2): He waits at the ford.');
		expect(message).toContain('Reply with a JSON array and nothing else');
		expect(message).toContain('"sceneIds"');
	});

	it('falls back to the opening of the body when a scene has no summary', () => {
		const message = buildSurveyMessage([surveyScene({ bodyMd: 'The gate stood open.' })], {
			scope: 'story'
		});
		expect(message).toContain('The Gate (id: s1): The gate stood open.');
	});

	it('cuts a long body excerpt and marks the cut', () => {
		const message = buildSurveyMessage([surveyScene({ bodyMd: 'x'.repeat(2000) })], {
			scope: 'story'
		});
		expect(message).toContain('[...]');
		expect(message).not.toContain('x'.repeat(1600));
	});

	it('marks an empty scene rather than listing nothing', () => {
		expect(buildSurveyMessage([surveyScene()], { scope: 'story' })).toContain('(empty)');
	});

	it('groups the universe listing by story and frames it as cross-story', () => {
		const message = buildSurveyMessage(
			[
				surveyScene({ id: 's1', storyTitle: 'First Light', summaryMd: 'A' }),
				surveyScene({ id: 's2', title: null, storyTitle: 'Second Dawn', summaryMd: 'B' })
			],
			{ scope: 'universe' }
		);
		expect(message).toContain('universe-wide continuity pass');
		expect(message).toContain('Story: First Light');
		expect(message).toContain('Story: Second Dawn');
		expect(message).toContain('The Gate (id: s1): A');
	});

	it('says a chunked survey is one part of the material', () => {
		const message = buildSurveyMessage([surveyScene({ summaryMd: 'A' })], {
			scope: 'story',
			chunk: { index: 2, total: 3 }
		});
		expect(message).toContain('part 2 of 3');
	});
});

describe('splitSurveyChunks', () => {
	it('keeps everything in one chunk when it fits', () => {
		const scenes = [surveyScene({ id: 's1' }), surveyScene({ id: 's2' })];
		expect(splitSurveyChunks(scenes, 1000)).toHaveLength(1);
	});

	it('splits in story order, without overlap, when the budget is spent', () => {
		const scenes = ['s1', 's2', 's3', 's4'].map((id) =>
			surveyScene({ id, summaryMd: 'y'.repeat(400) })
		);
		const chunks = splitSurveyChunks(scenes, 200);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.flat().map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
	});

	it('gives a scene that overruns the budget on its own a chunk of its own', () => {
		const chunks = splitSurveyChunks(
			[surveyScene({ id: 's1', summaryMd: 'z'.repeat(4000) }), surveyScene({ id: 's2' })],
			10
		);
		expect(chunks).toHaveLength(2);
		expect(chunks[0].map((s) => s.id)).toEqual(['s1']);
	});
});

describe('buildConfirmMessage', () => {
	it('carries the claim and the scene bodies, and forbids a re-read', () => {
		const message = buildConfirmMessage(
			'The harbour is east in one scene and west in the other.',
			[
				{ id: 's1', title: 'The Gate', bodyMd: 'The harbour lay east.' },
				{ id: 's2', title: null, bodyMd: 'The harbour lay west.', storyTitle: 'Second Dawn' }
			],
			1000
		);
		expect(message).toContain('The harbour is east in one scene and west in the other.');
		expect(message).toContain('do not call get_scene');
		expect(message).toContain('### The Gate (id: s1)');
		expect(message).toContain('The harbour lay east.');
		expect(message).toContain('[story: Second Dawn]');
		expect(message).toContain('discarded');
	});

	it('caps a long body and marks the cut', () => {
		const message = buildConfirmMessage(
			'claim',
			[{ id: 's1', title: null, bodyMd: 'w'.repeat(500) }],
			100
		);
		expect(message).toContain('the rest of this scene is cut to fit');
		expect(message).not.toContain('w'.repeat(200));
	});
});

describe('parseCandidates', () => {
	it('reads a clean array', () => {
		expect(parseCandidates('[{"sceneIds":["s1","s2"],"claim":"Names drift."}]')).toEqual([
			{ sceneIds: ['s1', 's2'], claim: 'Names drift.' }
		]);
	});

	it('reads an array inside a fenced code block', () => {
		const reply = '```json\n[{"sceneIds": ["s1"], "claim": "Ages do not add up."}]\n```';
		expect(parseCandidates(reply)).toEqual([{ sceneIds: ['s1'], claim: 'Ages do not add up.' }]);
	});

	it('reads an array wrapped in prose', () => {
		const reply =
			'Here is what I found:\n[{"sceneIds": ["s1", "s2"], "claim": "The harbour moves."}]\nThat is all.';
		expect(parseCandidates(reply)).toEqual([
			{ sceneIds: ['s1', 's2'], claim: 'The harbour moves.' }
		]);
	});

	it('reads an empty array as no candidates', () => {
		expect(parseCandidates('[]')).toEqual([]);
		expect(parseCandidates('Nothing to report: []')).toEqual([]);
	});

	it('drops entries missing a claim or scene ids', () => {
		const reply =
			'[{"sceneIds":["s1"],"claim":"Real."},{"claim":"No scenes."},{"sceneIds":["s2"],"claim":"  "},"nonsense"]';
		expect(parseCandidates(reply)).toEqual([{ sceneIds: ['s1'], claim: 'Real.' }]);
	});

	it('returns null when nothing parses', () => {
		expect(parseCandidates('I could not find any contradictions.')).toBeNull();
		expect(parseCandidates('[not json at all')).toBeNull();
	});

	it('treats an array of the wrong shape as no candidates, not a failure', () => {
		expect(parseCandidates('{"sceneIds": ["s1"]}')).toEqual([]);
	});

	it('skips a bracket in the prose ahead of the array', () => {
		const reply =
			'I checked scene [3] against the rest and found one problem.\n[{"sceneIds":["s1","s2"],"claim":"The harbour moves."}]';
		expect(parseCandidates(reply)).toEqual([
			{ sceneIds: ['s1', 's2'], claim: 'The harbour moves.' }
		]);
	});

	it('prefers the real findings over a stray empty array that came first', () => {
		const reply = '[]\nOn reflection:\n[{"sceneIds":["s1"],"claim":"Ages do not add up."}]';
		expect(parseCandidates(reply)).toEqual([{ sceneIds: ['s1'], claim: 'Ages do not add up.' }]);
	});

	it('keeps the fullest array when several parse', () => {
		const reply =
			'[{"sceneIds":["s1"],"claim":"One."}]\nand also\n[{"sceneIds":["s1"],"claim":"A."},{"sceneIds":["s2"],"claim":"B."}]';
		expect(parseCandidates(reply)).toEqual([
			{ sceneIds: ['s1'], claim: 'A.' },
			{ sceneIds: ['s2'], claim: 'B.' }
		]);
	});

	it('keeps the earliest array when two hold as much', () => {
		const reply =
			'[{"sceneIds":["s1"],"claim":"First."}]\nor maybe\n[{"sceneIds":["s2"],"claim":"Second."}]';
		expect(parseCandidates(reply)).toEqual([{ sceneIds: ['s1'], claim: 'First.' }]);
	});

	it('does not mistake a nested scene-id array for a second candidate array', () => {
		const reply = 'Findings: [{"sceneIds":["s1","s2","s3"],"claim":"Names drift."}]';
		expect(parseCandidates(reply)).toEqual([
			{ sceneIds: ['s1', 's2', 's3'], claim: 'Names drift.' }
		]);
	});
});
