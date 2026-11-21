import { describe, it, expect } from 'vitest';
import {
	buildConfirmMessage,
	buildContinuityBrief,
	buildPatternApplyMessage,
	buildPatternBrief,
	buildPatternSurveyMessage,
	buildRereadMessage,
	buildReviewMessage,
	buildSurveyMessage,
	mergePatterns,
	parseCandidates,
	parsePatterns,
	patternNoteBody,
	splitPatternChunks,
	splitSurveyChunks,
	type SurveyScene
} from './review';

// The briefs an outside agent gets over MCP say what the staged prompts say,
// in the same sentences.
describe('the briefs for an agent that runs a pass itself', () => {
	const shared = (brief: string, staged: string) =>
		brief.split('\n').filter((line) => staged.includes(line));

	it('gives the continuity brief the survey looks-for list and the confirm rules', () => {
		for (const scope of ['story', 'universe'] as const) {
			const brief = buildContinuityBrief({ scope, storyId: 'story-1' });
			const survey = buildSurveyMessage([], { scope });
			const looksFor = shared(brief, survey);
			// The story list's lore line names where the world is read from, so
			// it is the one line that differs between the two.
			expect(looksFor.filter((line) => line.startsWith('- ')).length).toBeGreaterThanOrEqual(
				scope === 'story' ? 2 : 3
			);
			expect(brief).not.toContain('the world context');
			if (scope === 'story') {
				expect(survey).toContain('or against the world context.');
				expect(brief).toContain('or against the entries you read with get_entity and search_text.');
			}
			expect(looksFor).toContain(
				'Judge only what spans scenes; spelling, grammar, and phrasing inside one scene are not this pass.'
			);
			const confirm = buildConfirmMessage('x', [], 100);
			expect(shared(brief, confirm).join(' ')).toContain(
				'If the text bears it out, stage one note'
			);
			expect(brief).toContain('this pass is continuity only');
			// The JSON hand-off between Codex's own stages is not for an agent.
			expect(brief).not.toContain('JSON');
			expect(brief).not.toContain('discarded');
		}
		expect(buildContinuityBrief({ scope: 'story', storyId: 'story-1' })).toContain(
			'the story with id story-1'
		);
		expect(buildContinuityBrief({ scope: 'universe' })).toContain('every story in this universe');
	});

	it('gives the pattern brief the survey looks-for list, the cap and the pattern note rule', () => {
		const brief = buildPatternBrief({ storyId: 'story-1', chapter: 'The Ford', cap: 5 });
		const survey = buildPatternSurveyMessage([], { scope: 'chapter', cap: 5 });
		const lines = shared(brief, survey);
		expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(4);
		expect(lines.join(' ')).toContain('Report at most 5, the ones that matter most.');
		const review = buildReviewMessage({ id: 's1', title: 'T' }, [], [], false, true);
		expect(shared(brief, review).join(' ')).toContain('use leave_pattern_note');
		expect(brief).toContain('the chapter "The Ford" of the story with id story-1');
		expect(brief).toContain('patternNoteId');
		expect(brief).not.toContain('JSON');
	});
});

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
		expect(buildReviewMessage({ id: 's1', title: null })).toContain('Review the scene with id s1.');
		expect(buildReviewMessage({ id: 's1', title: '   ' })).toContain(
			'Review the scene with id s1.'
		);
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

	it('asks for one comment per theme in the sparing and the exhaustive passes', () => {
		for (const categories of [[], ['prose'], ['mechanics', 'prose', 'lore']] as const) {
			const message = buildReviewMessage(scene, [], [...categories]);
			expect(message).toContain('Leave one comment per theme.');
			expect(message).toContain('Pattern note (');
		}
	});

	it('steers a recurring pattern to leave_pattern_note only when it is offered', () => {
		const withTool = buildReviewMessage(scene, [], [], true, true);
		expect(withTool).toContain('use leave_pattern_note');
		expect(withTool).toContain('list it under kept');
		const without = buildReviewMessage(scene, [], [], true, false);
		expect(without).not.toContain('leave_pattern_note');
		expect(without).toContain('separate suggest_edit calls');
	});

	it('tells the sparing pass that splitting notes by theme is not padding', () => {
		expect(buildReviewMessage(scene)).toContain('does not count against being sparing');
		expect(buildReviewMessage(scene, [], ['prose'])).not.toContain(
			'does not count against being sparing'
		);
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

describe('buildRereadMessage', () => {
	const base = {
		sceneId: 's9',
		sceneTitle: 'The Ford',
		passage: 'Kara crossed. She looked back.',
		changed: 'She',
		note: 'Pattern note (POV epithets): the elf\nshows up often.'
	};

	it('carries the passage, the change, and the note quoted line by line', () => {
		const message = buildRereadMessage(base);
		expect(message).toContain('"The Ford" (id: s9)');
		expect(message).toContain('now reads: "She"');
		expect(message).toContain('> Pattern note (POV epithets): the elf\n> shows up often.');
		expect(message.endsWith('Kara crossed. She looked back.')).toBe(true);
	});

	it('asks for at most one edit or the word fine', () => {
		const message = buildRereadMessage(base);
		expect(message).toContain('exactly one suggest_edit');
		expect(message).toContain('"fine"');
	});

	it('says when the accepted change was a deletion', () => {
		expect(buildRereadMessage({ ...base, changed: '' })).toContain('removed some text');
	});
});

describe('pattern pass prompts', () => {
	const scenes = [
		{ id: 's1', title: 'Dawn', bodyMd: 'She sighed. She sighed again.', chapterTitle: 'One' },
		{ id: 's2', title: null, bodyMd: 'He sighed.', chapterTitle: 'One' },
		{ id: 's3', title: 'Dusk', bodyMd: 'They sighed.', chapterTitle: 'Two' }
	];
	const pattern = {
		name: 'Sighing',
		description: 'Characters sigh to show feeling.',
		sceneIds: ['s1', 's2'],
		examples: ['She sighed.']
	};

	it('lists each scene by id, with chapter headings only where chapters are given', () => {
		const book = buildPatternSurveyMessage(scenes, { scope: 'book', cap: 8 });
		expect(book).toContain('whole-book');
		expect(book).toContain('at most 8');
		expect(book.match(/^## /gm)).toHaveLength(2);
		expect(book).toContain('### Untitled scene (id: s2)');
		const chapter = buildPatternSurveyMessage(
			scenes.map((s) => ({ id: s.id, title: s.title, bodyMd: s.bodyMd })),
			{ scope: 'chapter', cap: 5 }
		);
		expect(chapter).not.toMatch(/^## /m);
		expect(chapter).toContain('at most 5');
	});

	it('carries known patterns forward, names open ones to skip, and marks chunks', () => {
		const message = buildPatternSurveyMessage(scenes, {
			scope: 'book',
			cap: 8,
			known: [{ name: 'Sighing', description: 'sighs' }],
			open: ['Weather openings'],
			chunk: { index: 2, total: 3 }
		});
		expect(message).toContain('exactly the same name');
		expect(message).toContain('- Sighing: sighs');
		expect(message).toContain('- Weather openings');
		expect(message).toContain('part 2 of 3');
	});

	it('splits the listing into chunks within the budget', () => {
		const big = Array.from({ length: 6 }, (_, i) => ({
			id: `b${i}`,
			title: null,
			bodyMd: 'word '.repeat(400)
		}));
		const chunks = splitPatternChunks(big, 1000);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.flat().map((s) => s.id)).toEqual(big.map((s) => s.id));
	});

	it('parses a pattern list leniently and drops entries with no name or scenes', () => {
		const reply =
			'Here you go:\n```json\n[{"name":" Sighing ","description":"d","sceneIds":["s1","s1","s2"],"examples":["a",""," b "]},{"name":"","sceneIds":["s1"]},{"name":"x","sceneIds":[]}]\n```';
		expect(parsePatterns(reply)).toEqual([
			{ name: 'Sighing', description: 'd', sceneIds: ['s1', 's2'], examples: ['a', 'b'] }
		]);
		expect(parsePatterns('[]')).toEqual([]);
		expect(
			parsePatterns('[{"name":"Odd (one)","sceneIds":["s1"]},{"name":"()","sceneIds":["s1"]}]')
		).toEqual([{ name: 'Odd one', description: '', sceneIds: ['s1'], examples: [] }]);
		expect(parsePatterns('no list here')).toBeNull();
	});

	it('merges the same pattern from several replies by name, ignoring case and spacing', () => {
		const merged = mergePatterns([
			[{ name: 'Sighing', description: '', sceneIds: ['s1'], examples: ['a'] }],
			[
				{ name: 'sighing ', description: 'later', sceneIds: ['s1', 's3'], examples: ['a', 'b'] },
				{ name: 'Other', description: 'o', sceneIds: ['s2'], examples: [] }
			]
		]);
		expect(merged).toEqual([
			{ name: 'Sighing', description: 'later', sceneIds: ['s1', 's3'], examples: ['a', 'b'] },
			{ name: 'Other', description: 'o', sceneIds: ['s2'], examples: [] }
		]);
	});

	it('writes a note that names the pattern, an example, and where else it shows', () => {
		const body = patternNoteBody(pattern, { label: 'Shows up in', places: ['Dawn', 'Scene 2'] });
		expect(body.startsWith('Pattern note (Sighing): Characters sigh')).toBe(true);
		expect(body).toContain('For example: "She sighed."');
		expect(body).toContain('Shows up in: Dawn, Scene 2.');
		expect(patternNoteBody(pattern, { label: 'Shows up in', places: ['Dawn'] })).not.toContain(
			'Shows up in'
		);
	});

	it('hands the apply stage one scene, cut to fit', () => {
		const message = buildPatternApplyMessage(pattern, scenes[0], 12);
		expect(message).toContain('Sighing: Characters sigh');
		expect(message).toContain('(id: s1)');
		expect(message).toContain('the rest of this scene is cut to fit');
		expect(message).not.toContain('again');
	});
});
