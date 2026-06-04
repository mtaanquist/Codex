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
