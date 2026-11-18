import { describe, expect, it, vi } from 'vitest';
import { CHAT_TITLE_MAX, chatTitle, newChatId } from './assistant-chat';

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
