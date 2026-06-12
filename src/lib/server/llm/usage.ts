import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../auth';
import { assistantUsage } from '../db/schema';
import { logEvent } from '../log';
import type { TokenUsage } from './providers/types';

// The usage log: one row of metadata per request the gateway sends to the
// writer's endpoint, so the account page can show what the Assistant has been
// costing. Token counts come from the endpoint's own report and are null when
// it sent none; prompt text is never stored.

export type UsageEntry = {
	userId: string;
	storyId?: string;
	role: string;
	model: string;
	usage?: TokenUsage;
};

// Recording must never break a generation; a failed insert is logged and
// dropped.
export async function recordAssistantUsage(db: Database, entry: UsageEntry): Promise<void> {
	try {
		await db.insert(assistantUsage).values({
			userId: entry.userId,
			storyId: entry.storyId ?? null,
			role: entry.role,
			model: entry.model,
			promptTokens: entry.usage?.promptTokens ?? null,
			completionTokens: entry.usage?.completionTokens ?? null
		});
	} catch (err) {
		logEvent('warn', 'assistant.usage', {
			userId: entry.userId,
			error: err instanceof Error ? err.message : 'insert failed'
		});
	}
}

export type UsageRow = {
	id: string;
	role: string;
	model: string;
	promptTokens: number | null;
	completionTokens: number | null;
	createdAt: Date;
};

export type UsageSummary = {
	// The most recent requests, newest first.
	recent: UsageRow[];
	// Thirty-day totals across all requests, not just the listed ones.
	totals: { requests: number; promptTokens: number; completionTokens: number };
	// Thirty-day token sums per model, so a caller holding per-model prices can
	// estimate the period's cost.
	byModel: { model: string; promptTokens: number; completionTokens: number }[];
};

const RECENT_LIMIT = 50;
const TOTALS_DAYS = 30;

export async function recentAssistantUsage(db: Database, userId: string): Promise<UsageSummary> {
	const recent = await db
		.select({
			id: assistantUsage.id,
			role: assistantUsage.role,
			model: assistantUsage.model,
			promptTokens: assistantUsage.promptTokens,
			completionTokens: assistantUsage.completionTokens,
			createdAt: assistantUsage.createdAt
		})
		.from(assistantUsage)
		.where(eq(assistantUsage.userId, userId))
		.orderBy(desc(assistantUsage.createdAt))
		.limit(RECENT_LIMIT);

	const since = new Date(Date.now() - TOTALS_DAYS * 24 * 60 * 60 * 1000);
	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			promptTokens: sql<number>`coalesce(sum(${assistantUsage.promptTokens}), 0)::int`,
			completionTokens: sql<number>`coalesce(sum(${assistantUsage.completionTokens}), 0)::int`
		})
		.from(assistantUsage)
		.where(and(eq(assistantUsage.userId, userId), gte(assistantUsage.createdAt, since)));

	const byModel = await db
		.select({
			model: assistantUsage.model,
			promptTokens: sql<number>`coalesce(sum(${assistantUsage.promptTokens}), 0)::int`,
			completionTokens: sql<number>`coalesce(sum(${assistantUsage.completionTokens}), 0)::int`
		})
		.from(assistantUsage)
		.where(and(eq(assistantUsage.userId, userId), gte(assistantUsage.createdAt, since)))
		.groupBy(assistantUsage.model);

	return {
		recent,
		totals: totals ?? { requests: 0, promptTokens: 0, completionTokens: 0 },
		byModel
	};
}
