import { describe, it, expect } from 'vitest';
import { buildCoauthorMessage } from './coauthor';

describe('buildCoauthorMessage', () => {
	it('carries the brief and asks for bare, in-voice prose', () => {
		const message = buildCoauthorMessage('  a tense paragraph at the gate  ');
		// The brief is trimmed and quoted into the message.
		expect(message).toContain('"a tense paragraph at the gate"');
		expect(message).toMatch(/established voice/i);
		expect(message).toMatch(/only the passage/i);
	});
});
