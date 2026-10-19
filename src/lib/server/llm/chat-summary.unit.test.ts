import { describe, it, expect } from 'vitest';
import { planChatTurns, summaryBudgetTokens, turnDigest } from './chat-summary';
import { buildChatSummaryMessage } from './prompts/chat-summary';
import type { ChatMessage } from './providers/types';

// About four characters per token, so 400 characters costs about 100 tokens.
function turn(role: 'user' | 'assistant', label: string, chars = 400): ChatMessage {
	return { role, content: label + 'x'.repeat(Math.max(0, chars - label.length)) };
}

function conversation(count: number): ChatMessage[] {
	return Array.from({ length: count }, (_, i) =>
		turn(i % 2 === 0 ? 'user' : 'assistant', `t${i}-`)
	);
}

describe('planChatTurns', () => {
	it('sends every turn and no summary while the transcript fits', () => {
		const turns = conversation(4);
		const plan = planChatTurns(turns, 1000, null);
		expect(plan).toEqual({ summary: null, verbatim: turns, refresh: null });
	});

	it('summarises the older turns once the transcript overflows', () => {
		const turns = conversation(12); // about 1200 tokens
		const plan = planChatTurns(turns, 1000, null);
		expect(plan.refresh).not.toBeNull();
		// Half the budget stays verbatim, starting on a user turn.
		expect(plan.verbatim).toEqual(turns.slice(8));
		expect(plan.refresh!.turns).toEqual(turns.slice(0, 8));
		expect(plan.refresh!.coveredDigest).toBe(turnDigest(turns[7]));
	});

	it('reuses a stored summary without refreshing while the newer turns fit', () => {
		const turns = conversation(14);
		const stored = { summary: 'S'.repeat(400), coveredDigest: turnDigest(turns[7]) };
		const plan = planChatTurns(turns, 1000, stored);
		expect(plan.refresh).toBeNull();
		expect(plan.summary).toBe(stored.summary);
		expect(plan.verbatim).toEqual(turns.slice(8));
	});

	it('refreshes only the turns after the covered one when more fall out', () => {
		const turns = conversation(20);
		const stored = { summary: 'S'.repeat(400), coveredDigest: turnDigest(turns[7]) };
		const plan = planChatTurns(turns, 1000, stored);
		expect(plan.refresh!.turns).toEqual(turns.slice(8, 16));
		expect(plan.verbatim).toEqual(turns.slice(16));
		expect(plan.refresh!.coveredDigest).toBe(turnDigest(turns[15]));
		// If the refresh fails, the old summary goes with what still fits.
		expect(plan.refresh!.fallback).toEqual(turns.slice(12));
	});

	it('treats every turn as newer when the window has slid past the covered one', () => {
		const turns = conversation(4);
		const stored = { summary: 'earlier', coveredDigest: 'gone' };
		const plan = planChatTurns(turns, 1000, stored);
		expect(plan).toEqual({ summary: 'earlier', verbatim: turns, refresh: null });
	});

	it('never covers the newest turn', () => {
		const turns = [turn('user', 'big-', 8000)];
		const plan = planChatTurns(turns, 1000, null);
		expect(plan.refresh).toBeNull();
		expect(plan.verbatim).toEqual(turns);
	});
});

describe('summaryBudgetTokens', () => {
	it('takes a quarter of the transcript budget, capped', () => {
		expect(summaryBudgetTokens(4000)).toBe(1000);
		expect(summaryBudgetTokens(32000)).toBe(1500);
	});
});

describe('buildChatSummaryMessage', () => {
	it('carries the previous summary and labels the speakers', () => {
		const message = buildChatSummaryMessage('Earlier: the inn burned.', [
			{ role: 'user', content: 'Keep Bram alive.' },
			{ role: 'assistant', content: 'Noted.' }
		]);
		expect(message).toContain('Earlier: the inn burned.');
		expect(message).toContain('Writer: Keep Bram alive.');
		expect(message).toContain('Assistant: Noted.');
	});

	it('asks for a fresh summary when there is none yet', () => {
		const message = buildChatSummaryMessage(null, [{ role: 'user', content: 'Hi' }]);
		expect(message).not.toContain('Summary so far');
	});
});
