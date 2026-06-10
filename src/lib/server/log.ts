// Structured logs: one JSON object per line on stdout (stderr for errors), so a
// log collector can parse them. Keep field names short and stable, and never
// pass secrets or raw passwords in `fields`.

export type LogLevel = 'info' | 'warn' | 'error';

export function logEvent(
	level: LogLevel,
	event: string,
	fields: Record<string, unknown> = {}
): void {
	const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
	if (level === 'error') console.error(line);
	else console.log(line);
}

// Masks an email for logs: keeps the first character and the domain, so an
// operator can recognise an account without the full address sitting in logs.
export function redactEmail(email: string): string {
	const at = email.indexOf('@');
	if (at <= 0) return '***';
	return `${email[0]}***${email.slice(at)}`;
}
