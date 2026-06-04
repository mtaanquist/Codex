import { describe, it, expect } from 'vitest';
import { findTodoLines } from './todo-markers';

describe('findTodoLines', () => {
	it('finds lines beginning TODO: with correct offsets', () => {
		const body = 'First paragraph.\nTODO: fix the pacing here\nAfter.';
		const lines = findTodoLines(body);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual({
			from: 17,
			to: 42,
			text: 'fix the pacing here'
		});
		expect(body.slice(lines[0].from, lines[0].to)).toBe('TODO: fix the pacing here');
	});

	it('allows leading whitespace but not mid-line TODOs', () => {
		expect(findTodoLines('  TODO: indented')).toHaveLength(1);
		expect(findTodoLines('She said TODO: not a marker')).toHaveLength(0);
	});

	it('is case-sensitive, so prose mentioning todo stays prose', () => {
		expect(findTodoLines('todo: lowercase is just text')).toHaveLength(0);
	});

	it('finds several and handles an empty note', () => {
		const lines = findTodoLines('TODO:\nmiddle\nTODO: second');
		expect(lines).toHaveLength(2);
		expect(lines[0].text).toBe('');
		expect(lines[1].text).toBe('second');
	});

	it('returns nothing for empty text', () => {
		expect(findTodoLines('')).toHaveLength(0);
	});
});
