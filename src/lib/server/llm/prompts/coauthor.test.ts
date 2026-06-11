import { describe, it, expect } from 'vitest';
import {
	buildCoauthorMessage,
	readCoauthorReference,
	MAX_COAUTHOR_REFERENCE_CHARS
} from './coauthor';

describe('buildCoauthorMessage', () => {
	it('carries the brief and asks for bare, in-voice prose', () => {
		const message = buildCoauthorMessage('  a tense paragraph at the gate  ');
		// The brief is trimmed and quoted into the message.
		expect(message).toContain('"a tense paragraph at the gate"');
		expect(message).toMatch(/established voice/i);
		expect(message).toMatch(/only the passage/i);
	});

	it('frames a selection reference as the passage pointed at', () => {
		const message = buildCoauthorMessage('rewrite this', {
			kind: 'selection',
			text: 'The rain fell.'
		});
		expect(message).toContain('points at this passage');
		expect(message).toContain('The rain fell.');
		expect(message.indexOf('The rain fell.')).toBeLessThan(message.indexOf('"rewrite this"'));
	});

	it('frames a cursor reference as the place to continue from', () => {
		const message = buildCoauthorMessage('continue from here', {
			kind: 'cursor',
			text: 'She opened the door'
		});
		expect(message).toContain('cursor sits at the end of this passage');
		expect(message).toContain('She opened the door');
	});

	it('reads the same without a reference', () => {
		expect(buildCoauthorMessage('brief', null)).toBe(buildCoauthorMessage('brief'));
	});
});

describe('readCoauthorReference', () => {
	it('accepts the two kinds and trims the text', () => {
		expect(readCoauthorReference({ kind: 'selection', text: ' a ' })).toEqual({
			kind: 'selection',
			text: 'a'
		});
		expect(readCoauthorReference({ kind: 'cursor', text: 'b' })).toEqual({
			kind: 'cursor',
			text: 'b'
		});
	});

	it('rejects unknown kinds and empty text', () => {
		expect(readCoauthorReference(null)).toBeNull();
		expect(readCoauthorReference({ kind: 'other', text: 'a' })).toBeNull();
		expect(readCoauthorReference({ kind: 'cursor', text: '  ' })).toBeNull();
	});

	it('caps an oversized reference', () => {
		const reference = readCoauthorReference({
			kind: 'cursor',
			text: 'x'.repeat(MAX_COAUTHOR_REFERENCE_CHARS + 100)
		});
		expect(reference!.text).toHaveLength(MAX_COAUTHOR_REFERENCE_CHARS);
	});
});
