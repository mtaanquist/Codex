import { describe, it, expect } from 'vitest';
import {
	slashQuery,
	matchSlash,
	slashName,
	slashArgs,
	commandsForScope,
	SLASH_COMMANDS
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
		expect(matchSlash('/rev').map((c) => c.name)).toEqual(['review']);
		expect(matchSlash('/w').map((c) => c.name)).toEqual(['write', 'who']);
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
