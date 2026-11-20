import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { assistantUsage } from '../db/schema.ts';
import { logEvent } from '../log.ts';
import type { TokenUsage } from './providers/types.ts';

// The usage log: one row of metadata per request the gateway sends to the
// writer's endpoint, so the account page can show what the Assistant has been
// costing. Token counts come from the endpoint's own report and are null when
// it sent none. A request that failed or was cancelled before the endpoint
// reported its totals carries the adapter's estimate instead, and its row is
// marked estimated so it is never shown as a reported count. Prompt text is
// never stored.

export type UsageEntry = {
	userId: string;
	storyId?: string;
	role: string;
	model: string;
	usage?: TokenUsage;
	// The gateway's own chars/4 estimate for the request it just sent, when it
	// computed one. Logged against the endpoint's report, never stored.
	estimatedPromptTokens?: number;
};

// Observability for the token estimate the budgets are built on. The estimate
// is chars/4, which skews with non-English prose and with heavy markup, and
// budgets (context assembly, the agent loop's context guard) are increasingly
// load-bearing. Logging estimate against the endpoint's own count is phase one:
// once the ratios are observed per endpoint, a correction factor can be applied
// where estimateTokens feeds those budgets.
function logEstimateAccuracy(entry: UsageEntry): void {
	const actual = entry.usage?.promptTokens;
	const estimated = entry.estimatedPromptTokens;
	if (!actual || estimated === undefined || entry.usage?.estimated) return;
	logEvent('info', 'assistant.usage.estimate', {
		model: entry.model,
		estimated,
		actual,
		ratio: Math.round((estimated / actual) * 100) / 100
	});
}

// Recording must never break a generation; a failed insert is logged and
// dropped.
export async function recordAssistantUsage(db: Database, entry: UsageEntry): Promise<void> {
	logEstimateAccuracy(entry);
	try {
		await db.insert(assistantUsage).values({
			userId: entry.userId,
			storyId: entry.storyId ?? null,
			role: entry.role,
			model: entry.model,
			promptTokens: entry.usage?.promptTokens ?? null,
			completionTokens: entry.usage?.completionTokens ?? null,
			cachedPromptTokens: entry.usage?.cachedPromptTokens ?? null,
			cacheWriteTokens: entry.usage?.cacheWriteTokens ?? null,
			cacheWrite1hTokens: entry.usage?.cacheWrite1hTokens ?? null,
			estimated: entry.usage?.estimated ?? false,
			webSearchRequests: entry.usage?.webSearchRequests ?? null
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
	// The cache shares of promptTokens; null where none were reported.
	cachedPromptTokens: number | null;
	cacheWriteTokens: number | null;
	cacheWrite1hTokens: number | null;
	estimated: boolean;
	webSearchRequests: number | null;
	createdAt: Date;
};

export type UsageSummary = {
	// One page of requests, newest first.
	recent: UsageRow[];
	// The zero-based page recent holds, and whether older pages exist.
	page: number;
	hasMore: boolean;
	// Thirty-day totals across all requests, not just the listed ones.
	// estimatedRequests counts the rows whose counts are estimates.
	totals: {
		requests: number;
		promptTokens: number;
		completionTokens: number;
		estimatedRequests: number;
		webSearchRequests: number;
	};
	// Thirty-day token sums per model, so a caller holding per-model prices can
	// estimate the period's cost.
	byModel: {
		model: string;
		promptTokens: number;
		completionTokens: number;
		cachedPromptTokens: number;
		cacheWriteTokens: number;
		cacheWrite1hTokens: number;
	}[];
};

export const USAGE_PAGE_SIZE = 50;
const TOTALS_DAYS = 30;

export async function recentAssistantUsage(
	db: Database,
	userId: string,
	page = 0
): Promise<UsageSummary> {
	const safePage = Math.max(0, Math.floor(page));
	// Fetch one row past the page to learn whether an older page exists.
	const rows = await db
		.select({
			id: assistantUsage.id,
			role: assistantUsage.role,
			model: assistantUsage.model,
			promptTokens: assistantUsage.promptTokens,
			completionTokens: assistantUsage.completionTokens,
			cachedPromptTokens: assistantUsage.cachedPromptTokens,
			cacheWriteTokens: assistantUsage.cacheWriteTokens,
			cacheWrite1hTokens: assistantUsage.cacheWrite1hTokens,
			estimated: assistantUsage.estimated,
			webSearchRequests: assistantUsage.webSearchRequests,
			createdAt: assistantUsage.createdAt
		})
		.from(assistantUsage)
		.where(eq(assistantUsage.userId, userId))
		.orderBy(desc(assistantUsage.createdAt))
		.limit(USAGE_PAGE_SIZE + 1)
		.offset(safePage * USAGE_PAGE_SIZE);
	const recent = rows.slice(0, USAGE_PAGE_SIZE);

	const since = new Date(Date.now() - TOTALS_DAYS * 24 * 60 * 60 * 1000);
	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			promptTokens: sql<number>`coalesce(sum(${assistantUsage.promptTokens}), 0)::int`,
			completionTokens: sql<number>`coalesce(sum(${assistantUsage.completionTokens}), 0)::int`,
			estimatedRequests: sql<number>`(count(*) filter (where ${assistantUsage.estimated}))::int`,
			webSearchRequests: sql<number>`coalesce(sum(${assistantUsage.webSearchRequests}), 0)::int`
		})
		.from(assistantUsage)
		.where(and(eq(assistantUsage.userId, userId), gte(assistantUsage.createdAt, since)));

	const byModel = await db
		.select({
			model: assistantUsage.model,
			promptTokens: sql<number>`coalesce(sum(${assistantUsage.promptTokens}), 0)::int`,
			completionTokens: sql<number>`coalesce(sum(${assistantUsage.completionTokens}), 0)::int`,
			cachedPromptTokens: sql<number>`coalesce(sum(${assistantUsage.cachedPromptTokens}), 0)::int`,
			cacheWriteTokens: sql<number>`coalesce(sum(${assistantUsage.cacheWriteTokens}), 0)::int`,
			cacheWrite1hTokens: sql<number>`coalesce(sum(${assistantUsage.cacheWrite1hTokens}), 0)::int`
		})
		.from(assistantUsage)
		.where(and(eq(assistantUsage.userId, userId), gte(assistantUsage.createdAt, since)))
		.groupBy(assistantUsage.model);

	return {
		recent,
		page: safePage,
		hasMore: rows.length > USAGE_PAGE_SIZE,
		totals: totals ?? {
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
			estimatedRequests: 0,
			webSearchRequests: 0
		},
		byModel
	};
}
