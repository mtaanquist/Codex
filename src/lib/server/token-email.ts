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
import { armToken, type TokenKind } from './tokens.ts';

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

// Turns a queued job into the message to send. Returns null for a token that
// was revoked, used, or expired before the send, which is then skipped: a
// superseded email change or reset link should not go out.
export async function resolveEmailJob(db: Database, job: EmailJob): Promise<EmailMessage | null> {
	if (!('tokenId' in job)) return job;
	const armed = await armToken(db, job.tokenId);
	return armed ? BUILDERS[armed.kind](job.to, armed.token, job.origin) : null;
}
