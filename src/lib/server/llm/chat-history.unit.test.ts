import { describe, it, expect } from 'vitest';
import { fitChatTurns, mergeAdjacentTurns } from './chat-history';
import type { ChatMessage } from './providers/types';

// About four characters per token, so 400 characters costs about 100 tokens.
function turn(role: 'user' | 'assistant', label: string, chars = 400): ChatMessage {
	return { role, content: label + 'x'.repeat(Math.max(0, chars - label.length)) };
}

describe('fitChatTurns', () => {
	it('keeps every turn when the transcript fits', () => {
		const turns = [turn('user', 'a'), turn('assistant', 'b'), turn('user', 'c')];
		expect(fitChatTurns(turns, 1000)).toEqual(turns);
	});

	it('drops the oldest turns and keeps the rest in order', () => {
		const turns = [
			turn('user', 'a'),
			turn('assistant', 'b'),
			turn('user', 'c'),
			turn('assistant', 'd'),
			turn('user', 'e'),
			turn('assistant', 'f')
		];
		const fitted = fitChatTurns(turns, 250);
		expect(fitted).toEqual([turns[4], turns[5]]);
	});

	it('never starts the transcript on an assistant turn', () => {
		const turns = [
			turn('user', 'a'),
			turn('assistant', 'b'),
			turn('user', 'c'),
			turn('assistant', 'd'),
			turn('user', 'e')
		];
		// The budget fits the last two turns, the older of which is an assistant
		// reply; it goes rather than leading the transcript.
		expect(fitChatTurns(turns, 250)).toEqual([turns[4]]);
	});

	it('keeps a lone assistant turn rather than sending nothing', () => {
		const turns = [turn('assistant', 'only')];
		expect(fitChatTurns(turns, 1000)).toEqual(turns);
	});

	it('keeps the newest turn even when it alone exceeds the budget', () => {
		const turns = [turn('user', 'a'), turn('assistant', 'b'), turn('user', 'big', 20_000)];
		expect(fitChatTurns(turns, 100)).toEqual([turns[2]]);
	});
});

describe('mergeAdjacentTurns', () => {
	it('joins back-to-back turns of one role and leaves alternating turns alone', () => {
		const alternating: ChatMessage[] = [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
			{ role: 'user', content: 'c' }
		];
		expect(mergeAdjacentTurns(alternating)).toEqual(alternating);
		expect(
			mergeAdjacentTurns([
				{ role: 'user', content: 'a' },
				{ role: 'user', content: 'b' },
				{ role: 'assistant', content: 'c' },
				{ role: 'user', content: 'd' }
			])
		).toEqual([
			{ role: 'user', content: 'a\n\nb' },
			{ role: 'assistant', content: 'c' },
			{ role: 'user', content: 'd' }
		]);
	});

	it('leaves system and tool turns as they are', () => {
		const turns: ChatMessage[] = [
			{ role: 'system', content: 'a' },
			{ role: 'system', content: 'b' },
			{ role: 'user', content: 'c' }
		];
		expect(mergeAdjacentTurns(turns)).toEqual(turns);
	});
});
