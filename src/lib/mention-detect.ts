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
	// Present when the matched text belongs to more than one entity: the
	// full candidate set, attributed winner first.
	candidates?: { type: MentionTarget['type']; id: string }[];
};

// Context that settles shared names. Detection itself is context-free;
// these only decide which entity an ambiguous match is attributed to.
export type MentionContext = {
	// Entities declared in the story outrank the rest.
	storyMembers?: Set<string>;
	// The author's explicit per-story picks: matched text -> target id.
	pins?: Map<string, string>;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// When a name belongs to several entities, attribution is deterministic: a
// pinned pick wins outright; otherwise entities declared in the story come
// first, then characters before places before lore, then the entity whose
// primary name (rather than an alias) matched, then the stable id order.
const TYPE_RANK: Record<MentionTarget['type'], number> = {
	character: 0,
	place: 1,
	lore_entry: 2
};

function attribute(
	candidates: { name: string; target: MentionTarget }[],
	text: string,
	context: MentionContext
): MentionTarget[] {
	const ordered = [...candidates].sort((a, b) => {
		const aMember = context.storyMembers?.has(a.target.id) ? 0 : 1;
		const bMember = context.storyMembers?.has(b.target.id) ? 0 : 1;
		if (aMember !== bMember) return aMember - bMember;
		if (TYPE_RANK[a.target.type] !== TYPE_RANK[b.target.type]) {
			return TYPE_RANK[a.target.type] - TYPE_RANK[b.target.type];
		}
		const aPrimary = a.target.names[0]?.trim() === text ? 0 : 1;
		const bPrimary = b.target.names[0]?.trim() === text ? 0 : 1;
		if (aPrimary !== bPrimary) return aPrimary - bPrimary;
		return a.target.id < b.target.id ? -1 : 1;
	});
	const pinned = context.pins?.get(text);
	if (pinned) {
		const index = ordered.findIndex((entry) => entry.target.id === pinned);
		if (index > 0) ordered.unshift(...ordered.splice(index, 1));
	}
	return ordered.map((entry) => entry.target);
}

type Candidate = { name: string; target: MentionTarget };

type Matcher = {
	pattern: RegExp;
	// Matched text -> the distinct entities carrying it. One entity can carry
	// the same string as both name and alias; that is not an ambiguity.
	byName: Map<string, Candidate[]>;
};

// Building the alternation of every name is the expensive part, so it is
// done once per target list. The editor and the worker pass the same array on
// every call; a new array (an edited entity) builds a new matcher, so a
// target list is never changed in place once it has been scanned with.
const matchers = new WeakMap<MentionTarget[], Matcher | null>();

function compileMatcher(targets: MentionTarget[]): Matcher | null {
	const byName = new Map<string, Candidate[]>();
	for (const target of targets) {
		for (const raw of target.names) {
			const name = raw.trim();
			if (name.length <= 1) continue;
			const entries = byName.get(name) ?? [];
			if (!entries.some((entry) => entry.target.id === target.id)) {
				entries.push({ name, target });
			}
			byName.set(name, entries);
		}
	}
	if (byName.size === 0) return null;
	// Longest first, so the alternation prefers the longer overlapping name.
	const names = [...byName.keys()].sort((a, b) => b.length - a.length);
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}_])(${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
		'gu'
	);
	return { pattern, byName };
}

function matcherFor(targets: MentionTarget[]): Matcher | null {
	let matcher = matchers.get(targets);
	if (matcher === undefined) {
		matcher = compileMatcher(targets);
		matchers.set(targets, matcher);
	}
	return matcher;
}

// Finds non-overlapping, word-bounded, case-sensitive occurrences. Longer
// names win where they overlap ("Alice Vane" beats "Alice" at the same spot).
// Single-character names are ignored. offset is added to every position, for
// a caller scanning a slice of a larger document.
export function detectMentions(
	body: string,
	targets: MentionTarget[],
	context: MentionContext = {},
	offset = 0
): MentionMatch[] {
	const matcher = matcherFor(targets);
	if (!matcher) return [];
	// The cached pattern is shared, so this call keeps its own cursor.
	const pattern = new RegExp(matcher.pattern);

	const matches: MentionMatch[] = [];
	let match;
	while ((match = pattern.exec(body)) !== null) {
		const text = match[1];
		const candidates = matcher.byName.get(text);
		if (!candidates) continue;
		const ordered = attribute(candidates, text, context);
		const winner = ordered[0];
		matches.push({
			targetType: winner.type,
			targetId: winner.id,
			position: match.index + offset,
			length: text.length,
			text,
			...(ordered.length > 1
				? { candidates: ordered.map((target) => ({ type: target.type, id: target.id })) }
				: {})
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
