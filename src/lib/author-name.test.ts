import { describe, expect, it } from 'vitest';
import { authorInitials, authorName, authorNameOrHandle } from './author-name';

describe('authorName', () => {
	it('prefers the pen name', () => {
		expect(authorName({ penName: 'Kera Eressea', displayName: 'K. Taylor' })).toBe('Kera Eressea');
	});

	it('falls back to the display name', () => {
		expect(authorName({ penName: null, displayName: 'K. Taylor' })).toBe('K. Taylor');
	});

	it('treats a blank pen name as unset', () => {
		expect(authorName({ penName: '   ', displayName: 'K. Taylor' })).toBe('K. Taylor');
	});

	it('trims what it returns', () => {
		expect(authorName({ penName: ' Kera ' })).toBe('Kera');
	});

	it('is empty with nothing to go on', () => {
		expect(authorName(null)).toBe('');
		expect(authorName({})).toBe('');
		expect(authorName({ penName: null, displayName: null })).toBe('');
	});
});

describe('authorNameOrHandle', () => {
	it('uses the name when there is one', () => {
		expect(authorNameOrHandle({ displayName: 'K. Taylor' }, 'kara')).toBe('K. Taylor');
	});

	it('falls back to the handle as an address', () => {
		expect(authorNameOrHandle(null, 'kara')).toBe('@kara');
	});
});

describe('authorInitials', () => {
	it('takes the first and last initial', () => {
		expect(authorInitials('Kera Eressea')).toBe('KE');
	});

	it('takes one initial from one word', () => {
		expect(authorInitials('Kera')).toBe('K');
	});

	it('ignores middle names', () => {
		expect(authorInitials('Ada Grace Lovelace')).toBe('AL');
	});

	it('falls back to a question mark', () => {
		expect(authorInitials('   ')).toBe('?');
	});
});
