// Emails that carry a single-use link (verify, reset, email change, deletion
// cancel). The request queues only the reserved token's id; the worker arms the
// token and writes the link at send time, so the raw token is never stored in
// the job queue.
import type { Database } from './auth.ts';
import { DELETION_GRACE_DAYS } from './account-deletion.ts';
import {
	accountDeletionEmail,
	emailChangeEmail,
	passwordResetEmail,
	verificationEmail,
	type EmailMessage
} from './email.ts';
import { armToken, type ArmResult, type TokenKind } from './tokens.ts';

export type TokenEmailJob = { tokenId: string; to: string; origin: string };

// What the email queue carries: a finished message, or a token email to build.
export type EmailJob = EmailMessage | TokenEmailJob;

const BUILDERS: Record<TokenKind, (to: string, token: string, origin: string) => EmailMessage> = {
	email_verify: (to, token, origin) =>
		verificationEmail(to, `${origin}/verify-email?token=${token}`),
	password_reset: (to, token, origin) =>
		passwordResetEmail(to, `${origin}/reset-password?token=${token}`),
	email_change: (to, token, origin) =>
		emailChangeEmail(to, `${origin}/confirm-email-change?token=${token}`),
	deletion_cancel: (to, token, origin) =>
		accountDeletionEmail(to, `${origin}/cancel-deletion?token=${token}`, DELETION_GRACE_DAYS)
};

export type ResolvedEmail =
	{ message: EmailMessage } | { skipped: Extract<ArmResult, { ok: false }>['reason'] };

// Turns a queued job into the message to send, or says why it is skipped: a
// token revoked before the send (a superseded email change or reset link)
// should not go out, and neither should one that expired while the send was
// retrying.
export async function resolveEmailJob(db: Database, job: EmailJob): Promise<ResolvedEmail> {
	if (!('tokenId' in job)) return { message: job };
	const armed = await armToken(db, job.tokenId);
	if (!armed.ok) return { skipped: armed.reason };
	return { message: BUILDERS[armed.kind](job.to, armed.token, job.origin) };
}
