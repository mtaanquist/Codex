// Transactional email. Sending happens in the worker, so this module reads
// plain process.env rather than SvelteKit's env modules. Configuration is
// off by default: with no SMTP_URL set, messages are logged instead of sent,
// which is what a self-host instance without mail or a dev machine wants.

export type EmailMessage = { to: string; subject: string; text: string };

export function isEmailConfigured(): boolean {
	return Boolean(process.env.SMTP_URL);
}

// A nodemailer connection string, e.g. smtps://user:pass@smtp.example.com:465.
// Loaded lazily so the app bundle does not pull nodemailer in just to build a
// message; only the worker, which actually sends, ever imports it.
async function buildTransport() {
	const url = process.env.SMTP_URL;
	if (!url) return null;
	const { createTransport } = await import('nodemailer');
	return createTransport(url);
}

export async function sendEmail(message: EmailMessage): Promise<void> {
	const transport = await buildTransport();
	if (!transport) {
		console.log(
			`[email] not configured; would send:\n  To: ${message.to}\n  Subject: ${message.subject}\n\n${message.text}\n`
		);
		return;
	}
	await transport.sendMail({
		from: process.env.SMTP_FROM ?? 'Codex <no-reply@localhost>',
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
