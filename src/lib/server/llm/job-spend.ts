import { eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { assistantJobSpend } from '../db/schema.ts';
import { errorFields, logEvent } from '../log.ts';
import { REVIEW_RUN_RETENTION_DAYS } from '../review-runs.ts';
import { resolveLlmConfig } from './config.ts';
import { SpendMeter } from './spend.ts';

// The spend meter for one queued Assistant job. pg-boss retries a job under the
// same id, so the meter starts from what earlier attempts of that job spent and
// records its total as it goes. Without a job id (an inline or test caller) or
// a cap, it is a plain meter that stores nothing.
export async function jobSpendMeter(
	db: Database,
	opts: { userId: string; storyId?: string; jobId?: string }
): Promise<SpendMeter> {
	const { config } = await resolveLlmConfig(db, opts.userId, opts.storyId);
	const base = { pricing: config.modelPricing, capUsd: config.spendCapUsd };
	const jobId = opts.jobId;
	if (!jobId || !base.capUsd) return new SpendMeter(base);
	const [row] = await db
		.select({ spentUsd: assistantJobSpend.spentUsd })
		.from(assistantJobSpend)
		.where(eq(assistantJobSpend.jobId, jobId));
	return new SpendMeter({
		...base,
		spentUsd: row?.spentUsd ?? 0,
		persist: async (spentUsd) => {
			try {
				await db
					.insert(assistantJobSpend)
					.values({ jobId, userId: opts.userId, spentUsd })
					.onConflictDoUpdate({
						target: assistantJobSpend.jobId,
						set: { spentUsd, updatedAt: sql`clock_timestamp()` }
					});
			} catch (err) {
				logEvent('error', 'job_spend.save_failed', { jobId, ...errorFields(err) });
			}
		}
	});
}

export async function purgeJobSpend(
	db: Database,
	retentionDays = REVIEW_RUN_RETENTION_DAYS
): Promise<number> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const deleted = await db
		.delete(assistantJobSpend)
		.where(lt(assistantJobSpend.updatedAt, cutoff))
		.returning({ jobId: assistantJobSpend.jobId });
	return deleted.length;
}
