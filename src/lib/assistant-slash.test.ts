import { describe, it, expect } from 'vitest';
import {
	slashQuery,
	matchSlash,
	slashName,
	slashArgs,
	isSlashCommand,
	hasStrayArgs,
	commandsForScope,
	SLASH_COMMANDS,
	matchCommands,
	ACTION_GROUPS
} from './assistant-slash';

describe('slashQuery', () => {
	it('is null without a leading slash', () => {
		expect(slashQuery('hello')).toBeNull();
		expect(slashQuery('')).toBeNull();
	});

	it('is null once the input spans multiple lines', () => {
		expect(slashQuery('/review\nmore')).toBeNull();
	});

	it('is null once a space is typed (the command is chosen, now typing arguments)', () => {
		expect(slashQuery('/clear now')).toBeNull();
		expect(slashQuery('/write a tense standoff')).toBeNull();
	});

	it('returns the lower-cased word after the slash', () => {
		expect(slashQuery('/Rev')).toBe('rev');
		expect(slashQuery('/')).toBe('');
	});
});

describe('matchSlash', () => {
	it('matches commands by name prefix', () => {
		expect(matchSlash('/rev').map((c) => c.name)).toEqual(['review', 'continuity-review']);
		expect(matchSlash('/w').map((c) => c.name)).toEqual(['write', 'who']);
	});

	it('puts the command named ahead of one that only has the word in its label', () => {
		// /write is about drafting too, but /draft must not run it.
		expect(matchSlash('/draft').map((c) => c.name)).toEqual(['draft', 'draft-chapter']);
		expect(matchSlash('/dr').map((c) => c.name)).toEqual(['draft', 'draft-chapter']);
		expect(matchSlash('/draft-chapter').map((c) => c.name)).toEqual(['draft-chapter']);
		expect(matchSlash('/draft-')[0].name).toBe('draft-chapter');
		// A name the query starts beats a label word it starts: "Switch model"
		// is ahead of /summaries in the menu.
		expect(matchSlash('/s')[0].name).toBe('summaries');
		expect(matchSlash('/s').map((c) => c.name)).toContain('model');
		expect(matchSlash('/re').map((c) => c.name)).toEqual([
			'rewrite',
			'review',
			'continuity-review'
		]);
	});

	it('lists every command for a bare slash on a story', () => {
		expect(matchSlash('/')).toHaveLength(SLASH_COMMANDS.length);
	});

	it('hides story-only commands on the universe surface', () => {
		const names = matchSlash('/', true).map((c) => c.name);
		expect(names).not.toContain('write');
		expect(names).not.toContain('review');
		expect(names).not.toContain('copyedit');
		expect(names).toContain('find');
		expect(names).toContain('who');
		expect(names).toContain('help');
	});

	it('offers continuity-review on both the story and the universe surface', () => {
		expect(matchSlash('/continuity').map((c) => c.name)).toEqual(['continuity-review']);
		expect(matchSlash('/continuity', true).map((c) => c.name)).toEqual(['continuity-review']);
	});

	it('is empty for non-slash input and unknown prefixes', () => {
		expect(matchSlash('hello')).toEqual([]);
		expect(matchSlash('/zzz')).toEqual([]);
	});
});

describe('commandsForScope', () => {
	it('returns only the cross-scope commands for the universe', () => {
		expect(commandsForScope(true).every((c) => c.scope === 'both')).toBe(true);
		expect(commandsForScope(false)).toEqual(SLASH_COMMANDS);
	});
});

describe('slashName', () => {
	it('takes the first word and lower-cases it', () => {
		expect(slashName('/Help')).toBe('help');
		expect(slashName('/review scene 2')).toBe('review');
	});
});

describe('slashArgs', () => {
	it('returns everything after the first token, trimmed', () => {
		expect(slashArgs('/write a tense standoff at dawn')).toBe('a tense standoff at dawn');
		expect(slashArgs('/who  Marra ')).toBe('Marra');
	});

	it('is empty when the command has no arguments', () => {
		expect(slashArgs('/write')).toBe('');
		expect(slashArgs('/clear')).toBe('');
	});
});

describe('matchCommands', () => {
	it('matches a word of the label as well as the name', () => {
		expect(matchCommands('hist').map((c) => c.name)).toEqual(['history']);
		expect(matchCommands('catch').map((c) => c.name)).toEqual(['catchup']);
		expect(matchCommands('/summ').map((c) => c.name)).toEqual(['summaries']);
	});

	it('keeps every command in its group order', () => {
		const order = ACTION_GROUPS.map((group) => group.id);
		const groups = matchCommands('').map((c) => order.indexOf(c.group));
		expect(groups).toEqual([...groups].sort((a, b) => a - b));
	});

	it('offers the model before mute for "/m", so Enter does not mute', () => {
		expect(matchCommands('m')[0].name).toBe('model');
	});

	it('lists every command for an empty query', () => {
		expect(matchCommands('')).toEqual(SLASH_COMMANDS);
	});
});

describe('isSlashCommand', () => {
	it('knows the commands and their older names, whatever follows', () => {
		expect(isSlashCommand('/write a storm scene')).toBe(true);
		expect(isSlashCommand('/Help')).toBe(true);
		expect(isSlashCommand('/clear')).toBe(true);
		expect(isSlashCommand('/catch-up')).toBe(true);
	});

	it('is false for a line that only looks like a command', () => {
		expect(isSlashCommand('/r/fantasy says this is overdone')).toBe(false);
		expect(isSlashCommand('/reveiw')).toBe(false);
		expect(isSlashCommand('/')).toBe(false);
	});
});

describe('hasStrayArgs', () => {
	it('is true for words after a command that takes none', () => {
		expect(hasStrayArgs('/help me tighten this paragraph')).toBe(true);
		expect(hasStrayArgs('/new idea for chapter 3')).toBe(true);
		expect(hasStrayArgs('/clear the air between them')).toBe(true);
	});

	it('is false for a bare command and for one that takes words', () => {
		expect(hasStrayArgs('/help')).toBe(false);
		expect(hasStrayArgs('/new  ')).toBe(false);
		expect(hasStrayArgs('/write a storm scene')).toBe(false);
		expect(hasStrayArgs('/who Mira')).toBe(false);
	});
});
