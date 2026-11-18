import { describe, expect, it, vi } from 'vitest';
import { CHAT_TITLE_MAX, chatTitle, newChatId, withPrompt } from './assistant-chat';

describe('chatTitle', () => {
	it('collapses whitespace', () => {
		expect(chatTitle('  Who is\n\nMarra   really? ')).toBe('Who is Marra really?');
	});

	it('cuts a long first message to fit a row', () => {
		const title = chatTitle('word '.repeat(40));
		expect(title.length).toBeLessThanOrEqual(CHAT_TITLE_MAX);
		expect(title.endsWith('...')).toBe(true);
		expect(title.startsWith('word word')).toBe(true);
	});

	it('keeps a message that already fits', () => {
		const text = 'x'.repeat(CHAT_TITLE_MAX);
		expect(chatTitle(text)).toBe(text);
	});
});

describe('newChatId', () => {
	it('makes a version 4 uuid, also where crypto.randomUUID is missing', () => {
		const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(newChatId()).toMatch(shape);
		vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
		try {
			const made = newChatId();
			expect(made).toMatch(shape);
			expect(newChatId()).not.toBe(made);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('withPrompt', () => {
	it('puts the prompt in an empty box', () => {
		expect(withPrompt('  ', '', 'Check this.')).toBe('Check this.');
	});

	it('keeps typed text, with the prompt after it', () => {
		expect(withPrompt("Check Marra's age", '', 'A')).toBe("Check Marra's age\n\nA");
	});

	it('swaps an earlier prompt and keeps the text typed before it', () => {
		const first = withPrompt("Check Marra's age", '', 'A');
		expect(withPrompt(first, 'A', 'B')).toBe("Check Marra's age\n\nB");
	});

	it('replaces an earlier prompt left on its own', () => {
		expect(withPrompt('A', 'A', 'B')).toBe('B');
	});

	it('keeps an earlier prompt the writer added to', () => {
		expect(withPrompt('A and more', 'A', 'B')).toBe('A and more\n\nB');
	});

	it('replaces a half-typed command', () => {
		expect(withPrompt('/rec', '', 'B')).toBe('B');
	});
});
