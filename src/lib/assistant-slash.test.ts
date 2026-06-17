import { describe, it, expect } from 'vitest';
import { slashQuery, matchSlash, slashName, SLASH_COMMANDS } from './assistant-slash';

describe('slashQuery', () => {
	it('is null without a leading slash', () => {
		expect(slashQuery('hello')).toBeNull();
		expect(slashQuery('')).toBeNull();
	});

	it('is null once the input spans multiple lines', () => {
		expect(slashQuery('/review\nmore')).toBeNull();
	});

	it('returns the lower-cased first word after the slash', () => {
		expect(slashQuery('/Rev')).toBe('rev');
		expect(slashQuery('/clear now')).toBe('clear');
	});
});

describe('matchSlash', () => {
	it('matches commands by name prefix', () => {
		expect(matchSlash('/c').map((c) => c.name)).toEqual(['catchup', 'clear']);
		expect(matchSlash('/rev').map((c) => c.name)).toEqual(['review']);
	});

	it('lists every command for a bare slash', () => {
		expect(matchSlash('/')).toHaveLength(SLASH_COMMANDS.length);
	});

	it('is empty for non-slash input and unknown prefixes', () => {
		expect(matchSlash('hello')).toEqual([]);
		expect(matchSlash('/zzz')).toEqual([]);
	});
});

describe('slashName', () => {
	it('takes the first word and lower-cases it', () => {
		expect(slashName('/Help')).toBe('help');
		expect(slashName('/review scene 2')).toBe('review');
	});
});
