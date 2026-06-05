// Shared shapes for entity quick details and full-fidelity revision
// snapshots. Pure types and helpers only; building and applying snapshots
// is server-side work (src/lib/server/entity-history.ts).

export type EntityDetail = { label: string; value: string };

export type SnapshotRelationship = {
	relationTypeId: string;
	// Which side of the stored relationship row this entity is on.
	role: 'from' | 'to';
	otherType: 'character' | 'place' | 'lore_entry';
	otherId: string;
	notesMd: string | null;
	// Display strings as they were when the snapshot was taken, so a preview
	// stays readable after the type or target is renamed or removed.
	label: string;
	otherName: string;
};

// What an entity revision captures beyond the body. Aliases are recorded
// for characters, keywords for lore entries; places carry neither.
export type EntitySnapshot = {
	name: string;
	aliases?: string[];
	keywords?: string[];
	summaryMd: string | null;
	categoryId: string | null;
	categoryName: string | null;
	details: EntityDetail[];
	relationships: SnapshotRelationship[];
};

export const MAX_DETAILS = 50;
export const MAX_DETAIL_LABEL = 80;
export const MAX_DETAIL_VALUE = 400;

// Normalizes a details payload from the client: strings trimmed, rows
// missing a label or value dropped, caps applied.
export function cleanDetails(input: unknown): EntityDetail[] {
	if (!Array.isArray(input)) return [];
	const details: EntityDetail[] = [];
	for (const row of input) {
		if (details.length >= MAX_DETAILS) break;
		if (typeof row !== 'object' || row === null) continue;
		const { label, value } = row as { label?: unknown; value?: unknown };
		if (typeof label !== 'string' || typeof value !== 'string') continue;
		const cleanLabel = label.trim().slice(0, MAX_DETAIL_LABEL);
		const cleanValue = value.trim().slice(0, MAX_DETAIL_VALUE);
		if (cleanLabel === '' || cleanValue === '') continue;
		details.push({ label: cleanLabel, value: cleanValue });
	}
	return details;
}

// Serializes with object keys sorted, since Postgres jsonb does not keep
// key order; array order is preserved (and meaningful) on both sides.
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value);
}

// Snapshots are built deterministically (relationships ordered by row id),
// so structural equality reduces to a stable serialized compare.
export function snapshotsEqual(a: EntitySnapshot | null, b: EntitySnapshot | null): boolean {
	if (a === null || b === null) return a === b;
	return stableStringify(a) === stableStringify(b);
}
