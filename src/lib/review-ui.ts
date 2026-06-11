// Client-side helpers for the review workspace: turning a scene's threads and
// suggestions into inline marks over its text, colouring notes by who left
// them, and the filter maths the jump-list and thread panel share. Pure logic
// with no I/O so it unit-tests directly. The author colours are derived, not
// stored: owner and assistant get fixed tints, guests hash their name through
// the same palette the plan sidebar uses.
import { entityColor } from './entity-color';

export type ReviewFilter = 'all' | 'comments' | 'suggestions' | 'resolved';

// Just enough of a comment/suggestion author to colour and label it.
export type AuthorRef = { isOwner: boolean; isAssistant: boolean; name: string };

export type SuggestionKind = 'insert' | 'delete' | 'replace';

// A stable key for an author, so the same person colours consistently across
// marks and cards. Guests collapse by display name; that is enough to tint by.
export function authorKey(author: AuthorRef): string {
	if (author.isAssistant) return 'assistant';
	if (author.isOwner) return 'owner';
	return `reviewer:${author.name}`;
}

// The CSS colour for an author, as a token so it cannot inject style. The
// owner is the accent, the assistant a fixed violet, guests a hashed tint.
export function authorColor(author: AuthorRef): string {
	if (author.isAssistant) return 'var(--cat-violet)';
	if (author.isOwner) return 'var(--accent)';
	return entityColor(author.name);
}

// One or two initials for the avatar.
export function authorInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return '?';
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// The kind of edit a suggestion makes, read from its text: nothing removed is
// an insertion, nothing added is a deletion, otherwise a replacement.
export function suggestionKind(suggestion: {
	original: string;
	replacement: string;
}): SuggestionKind {
	if (!suggestion.original) return 'insert';
	if (!suggestion.replacement) return 'delete';
	return 'replace';
}

// The client shapes of a thread and a suggestion, matching what listThreads
// and listSuggestions return once serialised to the page.
export type ReviewComment = {
	id: string;
	body: string;
	authorName: string;
	isOwner: boolean;
	isAssistant: boolean;
	// The current viewer authored this comment, so they may retract it.
	mine: boolean;
	createdAt: Date | string;
};
export type ReviewThread = {
	id: string;
	sceneId: string;
	// Set when the thread is a suggestion's discussion; it renders on that
	// suggestion's card and stays out of the standalone comment list.
	suggestionId: string | null;
	anchor: { start: number; end: number } | null;
	anchorLost: boolean;
	resolvedAt: Date | string | null;
	createdAt: Date | string;
	comments: ReviewComment[];
};
export type ReviewSuggestion = {
	id: string;
	sceneId: string;
	reviewerName: string;
	isOwner: boolean;
	isAssistant: boolean;
	// The current viewer authored this suggestion, so they may retract it while
	// it is still pending.
	mine: boolean;
	original: string;
	replacement: string;
	status: 'pending' | 'accepted' | 'rejected';
	anchor: { start: number; end: number } | null;
	anchorLost: boolean;
	createdAt: Date | string;
};

// A thread is coloured by whoever opened it (its first comment).
export function threadAuthor(thread: ReviewThread): AuthorRef {
	const first = thread.comments[0];
	return first
		? { isOwner: first.isOwner, isAssistant: first.isAssistant, name: first.authorName }
		: { isOwner: false, isAssistant: false, name: 'Reviewer' };
}
export function suggestionAuthor(suggestion: ReviewSuggestion): AuthorRef {
	return {
		isOwner: suggestion.isOwner,
		isAssistant: suggestion.isAssistant,
		name: suggestion.reviewerName
	};
}

export type MarkThread = {
	id: string;
	anchor: { start: number; end: number } | null;
	author: AuthorRef;
};
export type MarkSuggestion = {
	id: string;
	anchor: { start: number; end: number } | null;
	status: 'pending' | 'accepted' | 'rejected';
	original: string;
	replacement: string;
	author: AuthorRef;
};

// An ordered run of the scene text. Plain runs render as-is; the rest carry the
// id of the note they belong to (so a click can focus its card) and the author
// colour. A replace keeps both halves so the panel and centre agree.
export type ReviewMark =
	| { kind: 'plain'; text: string }
	| { kind: 'comment'; text: string; id: string; color: string }
	| { kind: 'ins'; text: string; id: string; color: string }
	| { kind: 'del'; text: string; id: string; color: string }
	| { kind: 'replace'; before: string; after: string; id: string; color: string };

type MarkOp = { start: number; end: number; build: (text: string) => ReviewMark };

// The sorted, deduplicated mark operations for a scene: open comment anchors
// and pending suggestion ranges, gated by the filter. Shared by reviewMarks
// and reviewProse so they always agree on what is marked.
function markOps(
	threads: MarkThread[],
	suggestions: MarkSuggestion[],
	filter: ReviewFilter
): MarkOp[] {
	const ops: MarkOp[] = [];

	if (filter === 'all' || filter === 'comments') {
		for (const thread of threads) {
			if (!thread.anchor) continue;
			const color = authorColor(thread.author);
			ops.push({
				start: thread.anchor.start,
				end: thread.anchor.end,
				build: (text) => ({ kind: 'comment', text, id: thread.id, color })
			});
		}
	}

	if (filter === 'all' || filter === 'suggestions') {
		for (const suggestion of suggestions) {
			if (suggestion.status !== 'pending' || !suggestion.anchor) continue;
			const color = authorColor(suggestion.author);
			const kind = suggestionKind(suggestion);
			if (kind === 'insert') {
				ops.push({
					start: suggestion.anchor.start,
					end: suggestion.anchor.start,
					build: () => ({ kind: 'ins', text: suggestion.replacement, id: suggestion.id, color })
				});
			} else if (kind === 'delete') {
				ops.push({
					start: suggestion.anchor.start,
					end: suggestion.anchor.end,
					build: (text) => ({ kind: 'del', text, id: suggestion.id, color })
				});
			} else {
				ops.push({
					start: suggestion.anchor.start,
					end: suggestion.anchor.end,
					build: (text) => ({
						kind: 'replace',
						before: text,
						after: suggestion.replacement,
						id: suggestion.id,
						color
					})
				});
			}
		}
	}

	ops.sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start));
	return ops;
}

// Overlays open comment anchors and pending suggestion ranges onto the scene
// text, returning ordered non-overlapping runs. Accepted suggestions are
// already folded into the text server-side, and resolved/decided notes drop
// out, so only live work shows. Overlapping anchors keep the earlier one and
// skip the rest, matching how the marks render.
export function reviewMarks(
	bodyMd: string,
	threads: MarkThread[],
	suggestions: MarkSuggestion[],
	filter: ReviewFilter
): ReviewMark[] {
	const ops = markOps(threads, suggestions, filter);
	const out: ReviewMark[] = [];
	let ptr = 0;
	for (const op of ops) {
		if (op.start < ptr) continue; // overlaps the previous mark: skip it
		if (op.start > ptr) out.push({ kind: 'plain', text: bodyMd.slice(ptr, op.start) });
		out.push(op.build(bodyMd.slice(op.start, op.end)));
		ptr = op.end;
	}
	if (ptr < bodyMd.length) out.push({ kind: 'plain', text: bodyMd.slice(ptr) });
	return out;
}

// A detected entity mention: where it sits in the scene text and which entity
// it points at. The same shape detectMentions returns (position, length,
// targetId), so the surface can pass matches straight through.
export type ProseMention = { position: number; length: number; targetId: string };

export type ReviewProseRun = ReviewMark | { kind: 'mention'; text: string; entityId: string };

// Like reviewMarks, but also threads entity-mention highlights through the
// plain stretches between marks. Review marks always win: a mention that would
// fall inside a comment or suggestion run is dropped rather than nested, so the
// prose never carries an interactive span inside another.
export function reviewProse(
	bodyMd: string,
	threads: MarkThread[],
	suggestions: MarkSuggestion[],
	filter: ReviewFilter,
	mentions: ProseMention[]
): ReviewProseRun[] {
	const ops = markOps(threads, suggestions, filter);
	const sortedMentions = [...mentions].sort((a, b) => a.position - b.position);
	const out: ReviewProseRun[] = [];

	// Emit a plain stretch [from, to), splitting out any mention that sits
	// wholly inside it.
	let mi = 0;
	function emitPlain(from: number, to: number) {
		let p = from;
		while (mi < sortedMentions.length && sortedMentions[mi].position < from) mi++;
		while (mi < sortedMentions.length) {
			const m = sortedMentions[mi];
			if (m.position >= to) break;
			if (m.position + m.length > to) {
				mi++;
				continue;
			}
			if (m.position > p) out.push({ kind: 'plain', text: bodyMd.slice(p, m.position) });
			out.push({
				kind: 'mention',
				text: bodyMd.slice(m.position, m.position + m.length),
				entityId: m.targetId
			});
			p = m.position + m.length;
			mi++;
		}
		if (p < to) out.push({ kind: 'plain', text: bodyMd.slice(p, to) });
	}

	let ptr = 0;
	for (const op of ops) {
		if (op.start < ptr) continue;
		if (op.start > ptr) emitPlain(ptr, op.start);
		out.push(op.build(bodyMd.slice(op.start, op.end)));
		ptr = op.end;
	}
	if (ptr < bodyMd.length) emitPlain(ptr, bodyMd.length);
	return out;
}

// ---- filters shared by the jump-list and the thread panel ----

export function threadInFilter(
	thread: { resolvedAt: Date | string | null },
	filter: ReviewFilter
): boolean {
	if (filter === 'resolved') return thread.resolvedAt !== null;
	if (filter === 'suggestions') return false;
	return thread.resolvedAt === null; // all or comments
}

export function suggestionInFilter(
	suggestion: { status: 'pending' | 'accepted' | 'rejected' },
	filter: ReviewFilter
): boolean {
	if (filter === 'resolved') return suggestion.status !== 'pending';
	if (filter === 'comments') return false;
	return suggestion.status === 'pending'; // all or suggestions
}

// Sort key for document order within a scene; whole-scene notes (no anchor)
// float to the top.
export function anchorPos(anchor: { start: number; end: number } | null): number {
	return anchor ? anchor.start : -1;
}

// A short, single-line description of a suggestion for the jump-list.
export function suggestionSnippet(suggestion: { original: string; replacement: string }): string {
	const kind = suggestionKind(suggestion);
	const clip = (text: string, n: number) => text.trim().replace(/\s+/g, ' ').slice(0, n);
	if (kind === 'insert') return `Insert "${clip(suggestion.replacement, 40)}"`;
	if (kind === 'delete') return `Delete "${clip(suggestion.original, 40)}"`;
	return `"${clip(suggestion.original, 22)}" to "${clip(suggestion.replacement, 22)}"`;
}
