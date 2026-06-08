import { autocompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import type { ViewUpdate, DecorationSet } from '@codemirror/view';
import type { MentionEntity } from './editor-mentions';
import { entityLetter } from './entity-color';
import { badgeBackground, badgeImageSrc } from './entity-badge';

export type AutocompleteMode = 'off' | 'popup' | 'ghost';

const MIN_PREFIX = 2;
// How far back from the cursor a name being typed can start.
const LOOKBEHIND = 50;

// Every way an entity can be written, deduplicated case-insensitively.
function candidateNames(entities: MentionEntity[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const entity of entities) {
		for (const name of [entity.name, ...entity.aliases]) {
			const trimmed = name.trim();
			if (!trimmed) continue;
			const key = trimmed.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			names.push(trimmed);
		}
	}
	return names.sort((a, b) => a.localeCompare(b));
}

// Names the popup offers for what the user has typed so far. The prefix
// matches case-insensitively and a fully typed name is no longer offered.
export function completionCandidates(entities: MentionEntity[], prefix: string): string[] {
	if (prefix.length < MIN_PREFIX) return [];
	const lower = prefix.toLowerCase();
	return candidateNames(entities).filter(
		(name) => name.length > prefix.length && name.toLowerCase().startsWith(lower)
	);
}

// The popup's rows carry the entity behind each name, so a shared name
// shows once per entity with the kind telling them apart.
export function completionEntries(
	entities: MentionEntity[],
	prefix: string
): { label: string; entity: MentionEntity }[] {
	if (prefix.length < MIN_PREFIX) return [];
	const lower = prefix.toLowerCase();
	const seen = new Set<string>();
	const entries: { label: string; entity: MentionEntity }[] = [];
	for (const entity of entities) {
		for (const raw of [entity.name, ...entity.aliases]) {
			const name = raw.trim();
			if (name.length <= prefix.length || !name.toLowerCase().startsWith(lower)) continue;
			const key = `${entity.id}\n${name.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({ label: name, entity });
		}
	}
	return entries.sort((a, b) => a.label.localeCompare(b.label));
}

// The ghost-text match: the longest tail of the text before the cursor
// that starts at a word boundary and matches exactly one name. Ambiguity
// means no ghost at all; the popup mode is the place for choices.
export function ghostMatch(
	entities: MentionEntity[],
	textBefore: string
): { prefix: string; remainder: string } | null {
	const window = textBefore.slice(-LOOKBEHIND);
	const starts: number[] = [];
	const wordStart = /[\p{L}\p{N}_]+/gu;
	for (const match of window.matchAll(wordStart)) {
		if (match.index === 0 && textBefore.length > window.length) continue;
		starts.push(match.index);
	}
	// Longest prefix first: earlier word starts make longer prefixes.
	for (const start of starts) {
		const prefix = window.slice(start);
		const candidates = completionCandidates(entities, prefix);
		if (candidates.length === 1) {
			return { prefix, remainder: candidates[0].slice(prefix.length) };
		}
	}
	return null;
}

const POPUP_KINDS: Record<MentionEntity['type'], string> = {
	character: 'character',
	place: 'place',
	lore_entry: 'lore'
};

function popupExtension(entities: MentionEntity[]): Extension {
	// The badge renderer gets only the completion back, so the entity rides
	// alongside in a lookup.
	const byCompletion = new WeakMap<Completion, MentionEntity>();
	const source: CompletionSource = (context) => {
		const word = context.matchBefore(/[\p{L}\p{N}_]+/u);
		if (!word) return null;
		const prefix = context.state.sliceDoc(word.from, word.to);
		if (prefix.length < MIN_PREFIX && !context.explicit) return null;
		const options = completionEntries(entities, prefix).map(({ label, entity }) => {
			const completion: Completion = {
				label,
				type: 'text',
				detail: POPUP_KINDS[entity.type]
			};
			byCompletion.set(completion, entity);
			return completion;
		});
		if (options.length === 0) return null;
		return { from: word.from, options, validFor: /^[\p{L}\p{N}_]*$/u };
	};
	return [
		autocompletion({
			override: [source],
			icons: false,
			tooltipClass: () => 'ac-popup',
			// The coloured badge in front of each name, like the design's.
			addToOptions: [
				{
					position: 10,
					render: (completion) => {
						const entity = byCompletion.get(completion);
						if (!entity) return null;
						const badge = document.createElement('span');
						badge.className = 'ac-badge';
						const image = badgeImageSrc(entity);
						if (image) {
							badge.style.backgroundImage = `url("${image}")`;
							badge.style.backgroundSize = 'cover';
							badge.style.backgroundPosition = 'center';
						} else {
							badge.textContent = entityLetter(entity.name);
							badge.style.background = badgeBackground({
								name: entity.name,
								badgeColor: entity.badgeColor,
								categoryColor: entity.color
							});
						}
						return badge;
					}
				}
			]
		}),
		popupFooter
	];
}

// The design's key-hint footer. CodeMirror owns the tooltip element, so a
// plugin tacks the footer on once the popup is in the DOM.
const popupFooter = ViewPlugin.fromClass(
	class {
		constructor(readonly view: EditorView) {}
		update() {
			requestAnimationFrame(() => {
				const tooltip = this.view.dom.querySelector('.cm-tooltip-autocomplete.ac-popup');
				if (!tooltip || tooltip.querySelector('.ac-foot')) return;
				const foot = document.createElement('div');
				foot.className = 'ac-foot';
				const hint = (key: string, label: string) => {
					const wrap = document.createElement('span');
					const kbd = document.createElement('span');
					kbd.className = 'ac-key';
					kbd.textContent = key;
					wrap.appendChild(kbd);
					wrap.appendChild(document.createTextNode(label));
					return wrap;
				};
				foot.appendChild(hint('↑↓', ' navigate'));
				foot.appendChild(hint('⏎', ' select'));
				foot.appendChild(hint('esc', ''));
				tooltip.appendChild(foot);
			});
		}
	}
);

class GhostWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}
	eq(other: GhostWidget) {
		return other.text === this.text;
	}
	toDOM() {
		const span = document.createElement('span');
		span.className = 'cm-ghost-text';
		span.textContent = this.text;
		return span;
	}
}

function ghostExtension(entities: MentionEntity[]): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet = Decoration.none;
			remainder = '';

			constructor(view: EditorView) {
				this.compute(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.selectionSet || update.focusChanged) {
					this.compute(update.view);
				}
			}

			compute(view: EditorView) {
				this.remainder = '';
				this.decorations = Decoration.none;
				const selection = view.state.selection.main;
				if (!selection.empty || !view.hasFocus) return;
				const line = view.state.doc.lineAt(selection.head);
				const before = view.state.sliceDoc(
					Math.max(line.from, selection.head - LOOKBEHIND),
					selection.head
				);
				const match = ghostMatch(entities, before);
				if (!match) return;
				this.remainder = match.remainder;
				this.decorations = Decoration.set([
					Decoration.widget({ widget: new GhostWidget(match.remainder), side: 1 }).range(
						selection.head
					)
				]);
			}
		},
		{ decorations: (instance) => instance.decorations }
	);

	const acceptGhost = keymap.of([
		{
			key: 'Tab',
			run: (view) => {
				const instance = view.plugin(plugin);
				if (!instance || !instance.remainder) return false;
				const head = view.state.selection.main.head;
				view.dispatch({
					changes: { from: head, insert: instance.remainder },
					selection: { anchor: head + instance.remainder.length }
				});
				return true;
			}
		}
	]);

	return [plugin, Prec.high(acceptGhost)];
}

// The entity autocomplete behaviour for one editor, by user preference.
// Lives in a compartment so the mode can be reconfigured at runtime.
export function autocompleteExtensions(
	entities: MentionEntity[],
	mode: AutocompleteMode
): Extension {
	if (mode === 'popup') return popupExtension(entities);
	if (mode === 'ghost') return ghostExtension(entities);
	return [];
}
