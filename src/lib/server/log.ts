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

// Log fields for a caught error. An Error serialises to {} in JSON, so its
// message and stack are copied out by hand.
export function errorFields(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error) return { message: error.message, stack: error.stack };
	return { message: String(error) };
}

// Masks an email for logs: keeps the first character and the domain, so an
// operator can recognise an account without the full address sitting in logs.
export function redactEmail(email: string): string {
	const at = email.indexOf('@');
	if (at <= 0) return '***';
	return `${email[0]}***${email.slice(at)}`;
}
