import { describe, expect, it } from 'vitest';
import { findAsk, SLASH_COMMANDS, whoAsk } from '../../assistant-slash.ts';
import { REVIEW_CATEGORIES } from '../../review-shape.ts';
import { buildCoauthorMessage } from '../llm/prompts/coauthor.ts';
import { READ_WITH_TOOLS } from '../llm/prompts/format.ts';
import { buildRecapMessage } from '../llm/prompts/recap.ts';
import {
	buildContinuityBrief,
	buildPatternBrief,
	buildReviewMessage,
	CHAPTER_PATTERN_CAP
} from '../llm/prompts/review.ts';
import { buildSceneDraftMessage } from '../llm/prompts/scene-draft.ts';
import {
	buildMcpPrompt,
	mcpPrompts,
	PromptArgumentError,
	type PromptConnection
} from './prompts.ts';

const UNIVERSE = '11111111-1111-4111-8111-111111111111';
const STORY = '22222222-2222-4222-8222-222222222222';
const SCENE = '33333333-3333-4333-8333-333333333333';
const SUGGEST: PromptConnection = { permissions: ['read', 'suggest'] };
const READ: PromptConnection = { permissions: ['read'] };

const ids = { universeId: UNIVERSE, storyId: STORY, sceneId: SCENE };
const build = (name: string, args: Record<string, unknown> = {}, connection = SUGGEST) =>
	buildMcpPrompt(name, { ...ids, ...args }, connection);

describe('the prompts on offer', () => {
	it('has one for every Assistant command that starts work', () => {
		const flows = SLASH_COMMANDS.filter((command) =>
			['write', 'review', 'lookup'].includes(command.group)
		).map((command) => command.name);
		const offered = mcpPrompts(SUGGEST.permissions).map((prompt) => prompt.name);
		expect(offered).toEqual(expect.arrayContaining(flows));
		// The pattern pass is a tick box in the review window, not a command.
		expect(offered.sort()).toEqual([...flows, 'pattern-pass'].sort());
	});

	it('leaves out the ones that stage notes for a connection that may only read', () => {
		expect(
			mcpPrompts(READ.permissions)
				.map((prompt) => prompt.name)
				.sort()
		).toEqual(['catchup', 'draft', 'draft-chapter', 'find', 'rewrite', 'who', 'write']);
		for (const name of ['review', 'copyedit', 'continuity-review', 'pattern-pass']) {
			expect(() => build(name, {}, READ)).toThrow(`Unknown prompt: ${name}.`);
		}
		expect(() => build('no-such-prompt')).toThrow(PromptArgumentError);
	});

	it('asks for the universe in every prompt, first', () => {
		for (const prompt of mcpPrompts(SUGGEST.permissions)) {
			expect(prompt.arguments[0]).toMatchObject({ name: 'universeId', required: true });
			expect(prompt.title).toBeTruthy();
			expect(prompt.description).toBeTruthy();
		}
	});
});

describe('what a prompt says', () => {
	it('frames each one: the universe to pass, the tools to read with, and what happens to the result', () => {
		const args = {
			brief: 'The ford at dawn.',
			passage: 'The elf crossed.',
			instruction: 'Tighten it.',
			chapter: 'One',
			name: 'Kara',
			query: 'lantern'
		};
		for (const prompt of mcpPrompts(SUGGEST.permissions)) {
			const text = build(prompt.name, args);
			expect(text).toContain(
				`The universe id is ${UNIVERSE}; pass it as universeId on every call.`
			);
			expect(text).toContain('get_scene');
			const stages = text.includes("You cannot change the writer's text.");
			const replies = text.includes('Nothing you write here is put into Codex');
			expect(stages || replies).toBe(true);
			// An outside agent is handed no context: every prompt points at
			// what to read with the tools, and names no placeholder scene.
			for (const focus of ['', 'mechanics, prose, lore']) {
				const rendered = build(prompt.name, { ...args, focus });
				expect(rendered).not.toMatch(/in your context|the context establishes|world context/);
				expect(rendered).not.toContain('"this scene"');
				expect(rendered).not.toContain('tense, and point of view, and point');
				expect(rendered).not.toContain('voice and tense, and point of view');
			}
			// Plain ASCII throughout.
			expect([...text].every((character) => character.charCodeAt(0) < 128)).toBe(true);
		}
	});

	it('gives a review the Assistants own instruction, with the pattern tool', () => {
		const scene = { id: SCENE, title: null };
		expect(build('review')).toContain(
			buildReviewMessage(scene, [], [], false, true, READ_WITH_TOOLS)
		);
		expect(build('review', { focus: 'lore, mechanics' })).toContain(
			buildReviewMessage(scene, [], ['mechanics', 'lore'], false, true, READ_WITH_TOOLS)
		);
		expect(build('copyedit')).toContain(
			buildReviewMessage(scene, [], [...REVIEW_CATEGORIES], false, true, READ_WITH_TOOLS)
		);
		expect(build('copyedit')).toContain('This is a full copyedit pass.');
		expect(build('review')).toContain(`Review the scene with id ${SCENE}.`);
		expect(build('copyedit')).toContain(
			'facts checked against the world and entity details as you read them with your tools (get_scene, get_entity, search_text, find_appearances).'
		);
		expect(build('review')).toContain("wait in the writer's review in Codex");
	});

	it('checks one story or the whole universe for continuity', () => {
		expect(build('continuity-review')).toContain(
			buildContinuityBrief({ scope: 'story', storyId: STORY })
		);
		expect(build('continuity-review', { storyId: undefined })).toContain(
			buildContinuityBrief({ scope: 'universe' })
		);
	});

	it('runs a pattern pass over a chapter or a story, and hands the writer the link', () => {
		const chapter = build('pattern-pass', { chapter: 'The Ford' });
		expect(chapter).toContain(
			buildPatternBrief({ storyId: STORY, chapter: 'The Ford', cap: CHAPTER_PATTERN_CAP })
		);
		expect(chapter).toContain('leave_pattern_note');
		expect(chapter).toContain('patternNoteId');
		expect(chapter).toContain('Give the writer the link each pattern note returned');
		expect(build('pattern-pass')).toContain('one chapter at a time');
	});

	it('writes and rewrites from the co-author instruction', () => {
		const write = build('write', { brief: 'The ford at dawn.' });
		expect(write).toContain(
			buildCoauthorMessage('The ford at dawn.', null, { source: READ_WITH_TOOLS })
		);
		expect(write).toContain(`the scene with id ${SCENE}`);
		// Staged on the scene where the connection may, else given in the reply.
		expect(write).toContain('Hand it to the writer with stage_scene_draft');
		expect(write).toContain('that the passage is waiting on the scene');
		const said = build('write', { brief: 'The ford at dawn.' }, READ);
		expect(said).not.toContain('stage_scene_draft');
		expect(said).toContain('Nothing you write here is put into Codex');

		const args = { passage: 'The elf crossed.', instruction: 'Tighten it.' };
		const asked = buildCoauthorMessage(
			'Tighten it.',
			{ kind: 'selection', text: 'The elf crossed.' },
			{ source: READ_WITH_TOOLS, rewrite: true }
		);
		const staged = build('rewrite', args);
		expect(staged).toContain(asked);
		// It reads as a rewrite of the quoted passage, not as a new one.
		expect(staged).toContain(
			'Rewrite this passage of the current scene:\n\nThe elf crossed.\n\nRewrite it to this instruction:\n\n"Tighten it."'
		);
		expect(staged).not.toContain('Write a passage for the current scene');
		expect(staged).toContain('Then stage it with suggest_edit');
		const replied = build('rewrite', args, READ);
		expect(replied).toContain(asked);
		expect(replied).not.toContain('suggest_edit');
		expect(replied).toContain('Nothing you write here is put into Codex');
	});

	it('drafts a scene or a chapter from the scene draft instruction', () => {
		const draft = build('draft', { brief: 'They cross.', words: '1200', pov: 'Kara' });
		expect(draft).toContain(
			buildSceneDraftMessage({
				brief: 'They cross.',
				targetWords: 1200,
				pov: 'Kara',
				source: READ_WITH_TOOLS
			})
		);
		expect(draft).toContain('If the scene already has prose: Write the rest of the scene');
		expect(build('draft', { brief: 'They cross.' })).toContain('Aim for about 800 words');
		// The length is held to what a draft may be asked for.
		expect(build('draft', { brief: 'x', words: '999999' })).toContain('Aim for about 6000 words');

		const chapter = build('draft-chapter', { chapter: 'The Ford', brief: 'The crossing.' });
		expect(chapter).toContain(
			buildSceneDraftMessage({
				brief: '',
				chapterBrief: 'The crossing.',
				targetWords: 800,
				source: READ_WITH_TOOLS
			})
		);
		expect(chapter).toContain(`the chapter "The Ford" of the story with id ${STORY}`);

		// A draft is handed over with stage_scene_draft, never put in the scene.
		expect(draft).toContain('Hand it to the writer with stage_scene_draft');
		expect(draft).toContain('It never replaces prose the writer has.');
		expect(chapter).toContain('Hand each one to the writer with stage_scene_draft');
		for (const name of ['draft', 'draft-chapter']) {
			const said = build(name, { chapter: 'The Ford', brief: 'x' }, READ);
			expect(said).not.toContain('stage_scene_draft');
			expect(said).toContain('Nothing you write here is put into Codex');
		}
	});

	it('recaps, looks up and searches with the Assistants own asks', () => {
		expect(build('catchup')).toContain(buildRecapMessage(null));
		expect(build('catchup', { throughScene: 'The Ford' })).toContain(buildRecapMessage('The Ford'));
		expect(build('who', { name: 'Kara' })).toContain(whoAsk('Kara'));
		expect(build('find', { query: 'lantern' })).toContain(findAsk('lantern'));
	});
});

describe('arguments', () => {
	it('refuses an id that is not one, naming the argument', () => {
		expect(() => build('review', { universeId: 'nope' })).toThrow(
			'"universeId" must be an id from list_universes.'
		);
		expect(() => build('review', { sceneId: 'nope' })).toThrow(
			'"sceneId" must be an id from list_scenes.'
		);
		expect(() => build('pattern-pass', { storyId: '' })).toThrow('Give "storyId".');
		expect(() => build('continuity-review', { storyId: 'nope' })).toThrow(
			'"storyId" must be an id from list_stories.'
		);
	});

	it('refuses missing or oversized text and a focus or length it does not know', () => {
		expect(() => build('write')).toThrow('Give "brief".');
		expect(() => build('write', { brief: 42 })).toThrow('Give "brief".');
		expect(() => build('write', { brief: 'x'.repeat(4001) })).toThrow('"brief" is too long');
		expect(() => build('who', { name: 'x'.repeat(201) })).toThrow('"name" is too long');
		expect(() => build('review', { focus: 'vibes' })).toThrow(
			'"focus" takes any of mechanics, prose, lore'
		);
		expect(() => build('draft', { brief: 'x', words: 'many' })).toThrow(
			'"words" must be a whole number.'
		);
	});
});
