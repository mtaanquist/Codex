import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../auth';
import { assistantChatSummaries } from '../db/schema';
import { estimateTokens } from './context/assemble';
import { fitChatTurns, type ChatScope } from './chat-history';
import { complete, type GatewayDeps } from './gateway';
import { buildChatSummaryMessage, chatSummarySystemMessage } from './prompts/chat-summary';
import type { ChatMessage } from './providers/types';

// Turns that no longer fit the transcript budget are folded into a running
// summary instead of being dropped. The summary is refreshed only when turns
// fall out of the budget, and each refresh covers enough turns to leave half
// the budget free, so it is not rebuilt on every message.

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

// A fingerprint of one turn, so a stored summary can find its place in the
// transcript the browser sends, which is a sliding window with no ids.
export function turnDigest(turn: ChatMessage): string {
	return createHash('sha256').update(`${turn.role}\n${turn.content}`).digest('hex');
}

// The most a summary may take, as a share of the transcript budget.
export function summaryBudgetTokens(budgetTokens: number): number {
	return Math.min(1500, Math.floor(budgetTokens / 4));
}

function cost(turns: ChatMessage[]): number {
	return turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
}

export function planChatTurns(
	turns: ChatMessage[],
	budgetTokens: number,
	stored: StoredChatSummary | null
): ChatPlan {
	// The turns after the newest one the summary covers. The earliest match
	// wins, so a repeated short turn ("yes") can only make the summary overlap
	// a few verbatim turns, never hide one. With no match the window has slid
	// past the covered turn, and every turn sent is newer than the summary.
	let start = 0;
	if (stored) {
		const index = turns.findIndex((turn) => turnDigest(turn) === stored.coveredDigest);
		if (index >= 0) start = Math.min(index + 1, turns.length - 1);
	}
	const candidates = turns.slice(start);
	const summary = stored?.summary ?? null;
	const available = budgetTokens - (summary ? estimateTokens(summary) : 0);
	if (cost(candidates) <= available) {
		return { summary, verbatim: fitChatTurns(candidates, available), refresh: null };
	}

	const verbatim = fitChatTurns(candidates, Math.floor(budgetTokens / 2));
	const covered = candidates.slice(0, candidates.length - verbatim.length);
	if (covered.length === 0) {
		return { summary, verbatim: fitChatTurns(candidates, available), refresh: null };
	}
	return {
		summary,
		verbatim,
		refresh: {
			turns: covered,
			coveredDigest: turnDigest(covered[covered.length - 1]),
			fallback: fitChatTurns(candidates, available)
		}
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
		} catch (err) {
			if (opts.signal?.aborted) throw err;
			verbatim = plan.refresh.fallback;
		}
	}
	return {
		messages: summary ? [chatSummarySystemMessage(summary), ...verbatim] : verbatim,
		summarised: summary !== null
	};
}
