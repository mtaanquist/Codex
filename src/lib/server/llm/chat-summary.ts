import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../auth';
import { assistantChatSummaries } from '../db/schema';
import { estimateTokens } from './context/assemble';
import { fitChatTurns, type ChatScope } from './chat-history';
import { complete, type GatewayDeps } from './gateway';
import { buildChatSummaryMessage, chatSummarySystemMessage } from './prompts/chat-summary';
import type { ChatMessage } from './providers/types';
import { CHAT_WINDOW_TURNS } from '../../assistant-chat.ts';

// Turns that no longer fit the transcript budget are folded into a running
// summary instead of being dropped. The summary is refreshed only when turns
// fall out of the budget or pile up after it, and each refresh covers enough
// turns to leave half the budget free, so it is not rebuilt on every message.

// The browser sends only its newest CHAT_WINDOW_TURNS turns, so the summary
// must be refreshed before the turn it is anchored on slides out of that
// window; otherwise the turns in between would reach neither the summary nor
// the model. A refresh keeps at most KEEP_TURNS turns verbatim, and the next
// one comes once REFRESH_TURNS have built up after the summary.
const REFRESH_TURNS = CHAT_WINDOW_TURNS - 10;
const KEEP_TURNS = CHAT_WINDOW_TURNS / 2;

export type StoredChatSummary = { summary: string; coveredDigest: string };

export type ChatPlan = {
	// The summary to send ahead of the verbatim turns, before any refresh.
	summary: string | null;
	verbatim: ChatMessage[];
	// Set when turns fall out of the budget: fold these turns into the summary,
	// then send the result with `verbatim`. `fallback` is what to send instead,
	// beside the old summary, if the refresh fails.
	refresh: { turns: ChatMessage[]; coveredDigest: string; fallback: ChatMessage[] } | null;
};

// The summary's anchor: a fingerprint of the newest writer turn it covers and
// the writer turn before it, so it can find its place in the transcript the
// browser sends, which is a sliding window with no ids. Writer turns are the
// ones the server always stores, so the anchor survives a reload; pairing two
// keeps a repeated short reply ("yes") from matching the wrong place.
function anchorAt(turns: ChatMessage[], index: number): string {
	let previous = '';
	for (let i = index - 1; i >= 0; i--) {
		if (turns[i].role === 'user') {
			previous = turns[i].content;
			break;
		}
	}
	return createHash('sha256').update(`${previous}\n\0\n${turns[index].content}`).digest('hex');
}

// The anchor for a summary covering turns[0..end): its newest writer turn.
export function coveredAnchor(turns: ChatMessage[], end: number): string | null {
	for (let i = end - 1; i >= 0; i--) {
		if (turns[i].role === 'user') return anchorAt(turns, i);
	}
	return null;
}

// The most a summary may take, as a share of the transcript budget.
export function summaryBudgetTokens(budgetTokens: number): number {
	return Math.min(1500, Math.max(500, Math.floor(budgetTokens / 4)));
}

function cost(turns: ChatMessage[]): number {
	return turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
}

export function planChatTurns(
	turns: ChatMessage[],
	budgetTokens: number,
	stored: StoredChatSummary | null
): ChatPlan {
	// The turns after the summary: from the writer turn that follows its
	// anchor. With no match, every turn sent is treated as newer, which can
	// repeat what the summary holds but never hides a turn.
	let start = 0;
	if (stored) {
		const index = turns.findIndex(
			(turn, i) => turn.role === 'user' && anchorAt(turns, i) === stored.coveredDigest
		);
		if (index >= 0) {
			const next = turns.findIndex((turn, i) => i > index && turn.role === 'user');
			start = next >= 0 ? next : turns.length - 1;
		}
	}
	const candidates = turns.slice(start);
	const summary = stored?.summary ?? null;
	const available = budgetTokens - (summary ? estimateTokens(summary) : 0);
	const fallback = fitChatTurns(candidates, available);
	if (cost(candidates) <= available && candidates.length <= REFRESH_TURNS) {
		return { summary, verbatim: fallback, refresh: null };
	}

	const verbatim = fitChatTurns(candidates.slice(-KEEP_TURNS), Math.floor(budgetTokens / 2));
	const end = candidates.length - verbatim.length;
	// Anchored against the whole window, the way the next request will look it up.
	const coveredDigest = coveredAnchor(turns, start + end);
	if (!coveredDigest) return { summary, verbatim: fallback, refresh: null };
	return {
		summary,
		verbatim,
		refresh: { turns: candidates.slice(0, end), coveredDigest, fallback }
	};
}

function scopeWhere(scope: ChatScope) {
	return 'storyId' in scope
		? eq(assistantChatSummaries.storyId, scope.storyId)
		: eq(assistantChatSummaries.universeId, scope.universeId);
}

export async function getChatSummary(
	db: Database,
	userId: string,
	scope: ChatScope
): Promise<StoredChatSummary | null> {
	const [row] = await db
		.select({
			summary: assistantChatSummaries.summary,
			coveredDigest: assistantChatSummaries.coveredDigest
		})
		.from(assistantChatSummaries)
		.where(and(eq(assistantChatSummaries.userId, userId), scopeWhere(scope)));
	return row ?? null;
}

export async function hasChatSummary(
	db: Database,
	userId: string,
	scope: ChatScope
): Promise<boolean> {
	return (await getChatSummary(db, userId, scope)) !== null;
}

async function saveChatSummary(
	db: Database,
	userId: string,
	scope: ChatScope,
	value: StoredChatSummary
): Promise<void> {
	const storyScope = 'storyId' in scope;
	await db
		.insert(assistantChatSummaries)
		.values({
			userId,
			storyId: storyScope ? scope.storyId : null,
			universeId: storyScope ? null : scope.universeId,
			...value
		})
		.onConflictDoUpdate({
			target: storyScope
				? [assistantChatSummaries.storyId, assistantChatSummaries.userId]
				: [assistantChatSummaries.universeId, assistantChatSummaries.userId],
			set: { ...value, updatedAt: new Date() }
		});
}

// Fits a chat transcript to its budget, summarising the turns that fall out.
// The summary rides as a system message ahead of the verbatim turns. If the
// summary cannot be made (the Assistant is off for background work, the
// endpoint fails), the turns are dropped as before and the chat still runs.
export async function fitChatWithSummary(
	db: Database,
	opts: {
		userId: string;
		scope: ChatScope;
		turns: ChatMessage[];
		budgetTokens: number;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<{ messages: ChatMessage[]; summarised: boolean }> {
	const stored = await getChatSummary(db, opts.userId, opts.scope);
	const plan = planChatTurns(opts.turns, opts.budgetTokens, stored);
	let summary = plan.summary;
	let verbatim = plan.verbatim;
	if (plan.refresh) {
		try {
			const refreshed = (
				await complete(
					db,
					{
						userId: opts.userId,
						storyId: 'storyId' in opts.scope ? opts.scope.storyId : undefined,
						universeId: 'universeId' in opts.scope ? opts.scope.universeId : undefined,
						role: 'utility',
						enableTools: false,
						messages: [
							{
								role: 'user',
								content: buildChatSummaryMessage(summary, plan.refresh.turns)
							}
						],
						maxTokens: summaryBudgetTokens(opts.budgetTokens),
						signal: opts.signal
					},
					deps
				)
			).trim();
			if (refreshed) {
				summary = refreshed;
				await saveChatSummary(db, opts.userId, opts.scope, {
					summary,
					coveredDigest: plan.refresh.coveredDigest
				});
			} else {
				verbatim = plan.refresh.fallback;
			}
		} catch {
			// Includes a client that went away mid-summary: the chat request then
			// aborts on its own, so there is nothing more to report here.
			verbatim = plan.refresh.fallback;
		}
	}
	return {
		messages: summary ? [chatSummarySystemMessage(summary), ...verbatim] : verbatim,
		summarised: summary !== null
	};
}
