// Pure mention detection, shared by the server-side index rebuild and the
// editor's live underlines so both agree on what counts as a mention.

export type MentionTarget = {
	id: string;
	type: 'character' | 'place' | 'lore_entry';
	// Name first, then aliases and keywords.
	names: string[];
};

export type MentionMatch = {
	targetType: MentionTarget['type'];
	targetId: string;
	position: number;
	length: number;
	text: string;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Finds non-overlapping, word-bounded, case-sensitive occurrences. Longer
// names win where they overlap ("Alice Vane" beats "Alice" at the same spot).
// Single-character names are ignored.
export function detectMentions(body: string, targets: MentionTarget[]): MentionMatch[] {
	const names: { name: string; target: MentionTarget }[] = [];
	for (const target of targets) {
		for (const raw of target.names) {
			const name = raw.trim();
			if (name.length > 1) names.push({ name, target });
		}
	}
	if (names.length === 0) return [];

	// Longest first, so the alternation prefers the longer overlapping name.
	names.sort((a, b) => b.name.length - a.name.length);
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}_])(${names.map((n) => escapeRegExp(n.name)).join('|')})(?![\\p{L}\\p{N}_])`,
		'gu'
	);

	const matches: MentionMatch[] = [];
	let match;
	while ((match = pattern.exec(body)) !== null) {
		const text = match[1];
		const entry = names.find((n) => n.name === text);
		if (!entry) continue;
		matches.push({
			targetType: entry.target.type,
			targetId: entry.target.id,
			position: match.index,
			length: text.length,
			text
		});
	}
	return matches;
}

export function mentionSnippet(
	body: string,
	position: number,
	length: number,
	radius = 40
): string {
	const start = Math.max(0, position - radius);
	const end = Math.min(body.length, position + length + radius);
	const prefix = start > 0 ? '...' : '';
	const suffix = end < body.length ? '...' : '';
	return `${prefix}${body.slice(start, end)}${suffix}`;
}
