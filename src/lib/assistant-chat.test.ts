import { describe, expect, it } from 'vitest';
import { CHAT_TITLE_MAX, chatTitle } from './assistant-chat';

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
