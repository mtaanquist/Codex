import { StateField, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import {
	authorColor,
	suggestionAuthor,
	suggestionKind,
	threadAuthor,
	type ReviewFilter,
	type ReviewSuggestion,
	type ReviewThread
} from './review-ui';

// Review marks for the author's editable review centre: comment highlights and
// tracked-change suggestions drawn as CodeMirror decorations over the live
// document, so the prose stays editable underneath them. Positions map through
// the author's edits on their own; the surrounding component replaces the whole
// set (via setReviewMarks) only when the data reloads or the filter changes.

// A pending suggestion's inserted or replacement text is not in the document,
// so it rides as a non-editable ghost widget after the anchor.
class GhostWidget extends WidgetType {
	constructor(
		readonly text: string,
		readonly color: string,
		readonly rid: string,
		readonly focused: boolean
	) {
		super();
	}
	eq(other: GhostWidget) {
		return (
			other.text === this.text &&
			other.color === this.color &&
			other.rid === this.rid &&
			other.focused === this.focused
		);
	}
	toDOM() {
		const ins = document.createElement('ins');
		ins.className = this.focused ? 'rv-ins-t rv-ghost rv-mark is-focused' : 'rv-ins-t rv-ghost';
		ins.textContent = this.text;
		ins.style.setProperty('--auth', this.color);
		ins.dataset.rid = this.rid;
		return ins;
	}
	ignoreEvent() {
		return false;
	}
}

// Open, still-anchored comments show inline under All / Comments.
function commentInline(thread: ReviewThread, filter: ReviewFilter): boolean {
	if (thread.resolvedAt !== null || !thread.anchor) return false;
	return filter === 'all' || filter === 'comments';
}
// Pending, still-anchored suggestions show inline under All / Edits.
function suggestionInline(suggestion: ReviewSuggestion, filter: ReviewFilter): boolean {
	if (suggestion.status !== 'pending' || !suggestion.anchor) return false;
	return filter === 'all' || filter === 'suggestions';
}

// Builds the decoration set for the current data against the live document
// length. Out-of-range anchors (a passage rewritten out from under a mark) are
// skipped; the card still shows them as anchor-lost.
export function buildReviewMarks(
	threads: ReviewThread[],
	suggestions: ReviewSuggestion[],
	filter: ReviewFilter,
	docLength: number,
	focusedId: string | null = null
): DecorationSet {
	const ranges: { from: number; to: number; deco: Decoration }[] = [];
	const markClass = (base: string, id: string) => (id === focusedId ? `${base} is-focused` : base);

	for (const thread of threads) {
		if (!commentInline(thread, filter)) continue;
		const a = thread.anchor!;
		if (a.start >= a.end || a.start < 0 || a.end > docLength) continue;
		const color = authorColor(threadAuthor(thread));
		ranges.push({
			from: a.start,
			to: a.end,
			deco: Decoration.mark({
				class: markClass('rv-mark rv-comment', thread.id),
				attributes: { 'data-rid': thread.id, style: `--auth:${color}` }
			})
		});
	}

	for (const suggestion of suggestions) {
		if (!suggestionInline(suggestion, filter)) continue;
		const a = suggestion.anchor!;
		const color = authorColor(suggestionAuthor(suggestion));
		const kind = suggestionKind(suggestion);
		const focused = suggestion.id === focusedId;
		if (kind === 'insert') {
			if (a.start < 0 || a.start > docLength) continue;
			ranges.push({
				from: a.start,
				to: a.start,
				deco: Decoration.widget({
					widget: new GhostWidget(suggestion.replacement, color, suggestion.id, focused),
					side: 1
				})
			});
			continue;
		}
		if (a.start >= a.end || a.start < 0 || a.end > docLength) continue;
		ranges.push({
			from: a.start,
			to: a.end,
			deco: Decoration.mark({
				class: markClass(`rv-mark rv-${kind === 'delete' ? 'del' : 'replace'}`, suggestion.id),
				attributes: { 'data-rid': suggestion.id, style: `--auth:${color}` }
			})
		});
		if (kind === 'replace') {
			ranges.push({
				from: a.end,
				to: a.end,
				deco: Decoration.widget({
					widget: new GhostWidget(suggestion.replacement, color, suggestion.id, focused),
					side: 1
				})
			});
		}
	}

	// Decoration.set sorts by from then start side; mark ranges and point
	// widgets coexist as long as every range is well formed.
	return Decoration.set(
		ranges.map((r) => r.deco.range(r.from, r.to)),
		true
	);
}

// Replaces the whole mark set. Dispatched by the component on data reload or a
// filter change; between dispatches the field maps the set through edits.
export const setReviewMarks = StateEffect.define<DecorationSet>();

const reviewMarksField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(value, tr) {
		value = value.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setReviewMarks)) value = effect.value;
		}
		return value;
	},
	provide: (field) => EditorView.decorations.from(field)
});

export type ReviewMarksHandle = {
	extension: Extension;
	// Reads a mark's mapped anchor straight from the live field, so a comment or
	// suggestion the author has since dragged through edits anchors correctly.
	anchorOf(view: EditorView, rid: string): { start: number; end: number } | null;
};

// The editable review centre's mark behaviour: the decoration field, a click
// handler that focuses the matching card, and an update/scroll listener that
// lets the component reposition the rail and selection toolbar.
export function reviewMarksExtension(opts: {
	onFocusMark: (rid: string) => void;
	onGeometry: (view: EditorView) => void;
}): ReviewMarksHandle {
	const handlers = EditorView.domEventHandlers({
		mousedown(event) {
			const target = event.target as HTMLElement | null;
			const mark = target?.closest('.rv-mark, .rv-ghost') as HTMLElement | null;
			const rid = mark?.dataset.rid;
			if (rid) {
				event.stopPropagation();
				opts.onFocusMark(rid);
				return true;
			}
			return false;
		},
		scroll(_event, view) {
			opts.onGeometry(view);
			return false;
		}
	});

	const listener = EditorView.updateListener.of((update) => {
		if (update.docChanged || update.selectionSet || update.geometryChanged) {
			opts.onGeometry(update.view);
		}
	});

	return {
		extension: [reviewMarksField, handlers, listener],
		anchorOf(view, rid) {
			const set = view.state.field(reviewMarksField, false);
			if (!set) return null;
			let found: { start: number; end: number } | null = null;
			const cursor = set.iter();
			while (cursor.value) {
				if ((cursor.value.spec.attributes?.['data-rid'] as string | undefined) === rid) {
					found = { start: cursor.from, end: cursor.to };
					break;
				}
				cursor.next();
			}
			return found;
		}
	};
}
