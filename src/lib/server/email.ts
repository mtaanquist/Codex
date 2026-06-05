// Transactional email. Sending happens in the worker. The SMTP relay is
// configured from the admin panel (stored in app_settings) or seeded from the
// environment; see settings.ts. With neither set, messages are logged instead
// of sent, which is what a self-host instance without mail or a dev box wants.
import type { Database } from './auth';
import { effectiveSmtp } from './settings.ts';

export type EmailMessage = { to: string; subject: string; text: string };

// nodemailer is loaded lazily so the app bundle does not pull it in just to
// build a message; only the worker, which actually sends, reaches this.
export async function sendEmail(db: Database, message: EmailMessage): Promise<void> {
	const config = await effectiveSmtp(db);
	if (!config) {
		console.log(
			`[email] not configured; would send:\n  To: ${message.to}\n  Subject: ${message.subject}\n\n${message.text}\n`
		);
		return;
	}
	const { createTransport } = await import('nodemailer');
	const transport = createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: config.user ? { user: config.user, pass: config.password } : undefined
	});
	await transport.sendMail({
		from: config.from,
		to: message.to,
		subject: message.subject,
		text: message.text
	});
}

export function verificationEmail(to: string, link: string): EmailMessage {
	return {
		to,
		subject: 'Confirm your email address',
		text: [
			'Welcome to Codex.',
			'',
			'Open this link to confirm your email address:',
			link,
			'',
			'The link is good for 24 hours. If you did not create an account, you can ignore this message.'
		].join('\n')
	};
}

export function signupNotificationEmail(
	to: string,
	signup: { displayName: string; email: string },
	reviewLink: string,
	invited = false
): EmailMessage {
	// An invited sign-up is already approved, so the operator gets an FYI
	// rather than a request to act.
	if (invited) {
		return {
			to,
			subject: 'Someone joined with an invite code',
			text: [
				`${signup.displayName} (${signup.email}) has signed up with an invite code and is approved.`,
				'',
				'See all accounts here:',
				reviewLink
			].join('\n')
		};
	}
	return {
		to,
		subject: 'A new account is waiting for review',
		text: [
			`${signup.displayName} (${signup.email}) has signed up and is waiting for approval.`,
			'',
			'Review pending accounts here:',
			reviewLink
		].join('\n')
	};
}

export function emailChangeEmail(to: string, link: string): EmailMessage {
	return {
		to,
		subject: 'Confirm your new email address',
		text: [
			'You asked to change the email address on your Codex account to this one.',
			'',
			'Open this link to confirm the change:',
			link,
			'',
			'The link is good for 24 hours. Until you confirm, your account keeps its current address. If you did not ask for this, you can ignore this message.'
		].join('\n')
	};
}

export function accountDeletionEmail(to: string, cancelLink: string, days: number): EmailMessage {
	return {
		to,
		subject: 'Your account is scheduled for deletion',
		text: [
			`Your Codex account is scheduled to be permanently deleted in ${days} days.`,
			'',
			'If you did not ask for this, or you have changed your mind, open this link to cancel and keep your account:',
			cancelLink,
			'',
			'Once the deletion runs, everything you have written is removed for good and cannot be recovered.'
		].join('\n')
	};
}

export function passwordResetEmail(to: string, link: string): EmailMessage {
	return {
		to,
		subject: 'Reset your password',
		text: [
			'We received a request to reset your Codex password.',
			'',
			'Open this link to choose a new one:',
			link,
			'',
			'The link is good for 1 hour. If you did not ask for this, you can ignore this message and your password stays the same.'
		].join('\n')
	};
}
