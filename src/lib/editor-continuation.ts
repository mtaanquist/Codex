import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state';

// LLM continuation: the writer presses the request key and the Assistant offers
// an inline grey continuation of the prose at the cursor. Tab accepts it, Esc
// (or typing, or moving the cursor) dismisses it. This is its own extension,
// distinct from the entity autocomplete ghost-text - they share the look, not
// the source: this one comes from the model over the network, that one from a
// local name match.
//
// First cut: the suggestion is requested on demand (not auto-fired on every
// pause, which would hammer a metered endpoint) and arrives buffered, not
// streamed. On-pause triggering and token streaming are later refinements.

// How much preceding prose to send as the thing to continue.
const LOOKBEHIND = 4000;
// Cap the continuation so one request cannot run away on a slow endpoint.
const MAX_TOKENS = 220;

class GhostWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}
	eq(other: GhostWidget) {
		return other.text === this.text;
	}
	toDOM() {
		const span = document.createElement('span');
		// Shares the entity ghost-text styling.
		span.className = 'cm-ghost-text';
		span.textContent = this.text;
		return span;
	}
}

type Suggestion = { text: string; from: number };

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
	create: () => null,
	update(value, tr) {
		for (const effect of tr.effects) if (effect.is(setSuggestion)) return effect.value;
		// Any edit, or moving the caret off the anchor, makes a pending suggestion
		// stale.
		if (value) {
			if (tr.docChanged) return null;
			if (tr.selection && tr.state.selection.main.head !== value.from) return null;
		}
		return value;
	},
	provide: (field) =>
		EditorView.decorations.from(field, (value) =>
			value
				? Decoration.set([
						Decoration.widget({ widget: new GhostWidget(value.text), side: 1 }).range(value.from)
					])
				: Decoration.none
		)
});

// The Assistant continuation behaviour for one editor, scoped to a story. Lives
// behind the surfaces gate (the caller only adds it when the Assistant is on
// for the story), so the request key does nothing when the Assistant is off.
export function continuationExtensions(storyId: string): Extension {
	let pending: AbortController | null = null;

	const requestKey = keymap.of([
		{
			key: 'Mod-j',
			run: (view) => {
				const selection = view.state.selection.main;
				if (!selection.empty) return false;
				const head = selection.head;
				const before = view.state.sliceDoc(Math.max(0, head - LOOKBEHIND), head);
				if (!before.trim()) return false;
				pending?.abort();
				const controller = new AbortController();
				pending = controller;
				// Clear any showing suggestion while the next one is fetched.
				view.dispatch({ effects: setSuggestion.of(null) });
				fetch('/api/assistant/continuation', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ storyId, textBefore: before, maxTokens: MAX_TOKENS }),
					signal: controller.signal
				})
					.then((response) => (response.ok ? response.json() : Promise.reject(response)))
					.then((data: { text?: string }) => {
						const text = (data.text ?? '').replace(/\s+$/, '');
						// Only show it if the caret is still where the request was made.
						if (
							text &&
							view.state.selection.main.head === head &&
							!view.state.field(suggestionField)
						) {
							view.dispatch({ effects: setSuggestion.of({ text, from: head }) });
						}
					})
					.catch(() => {})
					.finally(() => {
						if (pending === controller) pending = null;
					});
				return true;
			}
		}
	]);

	const acceptKey = keymap.of([
		{
			key: 'Tab',
			run: (view) => {
				const suggestion = view.state.field(suggestionField);
				if (!suggestion) return false;
				view.dispatch({
					changes: { from: suggestion.from, insert: suggestion.text },
					selection: { anchor: suggestion.from + suggestion.text.length },
					effects: setSuggestion.of(null)
				});
				return true;
			}
		}
	]);

	const dismissKey = keymap.of([
		{
			key: 'Escape',
			run: (view) => {
				if (!view.state.field(suggestionField)) return false;
				pending?.abort();
				view.dispatch({ effects: setSuggestion.of(null) });
				return true;
			}
		}
	]);

	return [suggestionField, Prec.high(acceptKey), Prec.high(requestKey), Prec.high(dismissKey)];
}
