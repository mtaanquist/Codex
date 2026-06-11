import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

// Builds the jsonb expression for an override patch: values merge into the
// column, null removes the key so it falls back to the underlying setting,
// and undefined leaves it untouched. Worker-safe (no $env).
export function jsonbMergePatch(column: AnyColumn, patch: Record<string, unknown>): SQL {
	const set: Record<string, unknown> = {};
	const clear: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (value === null) clear.push(key);
		else set[key] = value;
	}
	let expression: SQL = sql`${column} || ${JSON.stringify(set)}::jsonb`;
	for (const key of clear) {
		expression = sql`(${expression}) - ${key}::text`;
	}
	return expression;
}
