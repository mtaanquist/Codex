import {
	Decoration,
	EditorView,
	hoverTooltip,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { detectMentions, type MentionContext, type MentionTarget } from './mention-detect';
import { entityColor, entityLetter } from './entity-color';

export type MentionEntity = {
	id: string;
	type: MentionTarget['type'];
	name: string;
	aliases: string[];
	summaryMd: string | null;
	details?: { label: string; value: string }[];
	// The category's colour and name, when the entity has one; the colour
	// drives the badge, the name rides the kind line on the hover card.
	color?: string | null;
	categoryName?: string | null;
	// A few related entities for the hover card's chips.
	related?: { name: string; color: string | null }[];
};

export type MentionOptions = {
	// Entities declared in the story, outranking the rest on shared names.
	storyMembers?: string[];
	// The story's pins: matched text -> entity id.
	pins?: Record<string, string>;
	// Called when the author picks which entity an ambiguous name means.
	onPin?: (name: string, target: { type: MentionTarget['type']; id: string }) => void;
	// Where "Open full details" points for an entity.
	entityHref?: (entity: { type: MentionTarget['type']; id: string }) => string;
	// When set, "Open full details" opens the read-only card in the right
	// column instead of navigating to the plan.
	onOpenCard?: (entityId: string) => void;
};

// The hover card shows the first few quick details and related entities;
// the rest live on the entity's page. Detail order is the author's, so
// the top ones are theirs to pick.
const TOOLTIP_DETAILS = 3;
const TOOLTIP_RELATED = 4;

const TYPE_LABELS: Record<MentionTarget['type'], string> = {
	character: 'character',
	place: 'place',
	lore_entry: 'lore'
};

const KIND_LABELS: Record<MentionTarget['type'], string> = {
	character: 'Character',
	place: 'Place',
	lore_entry: 'Lore'
};

function el(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function badge(name: string, color: string | null | undefined, size: 'sm' | 'dot'): HTMLElement {
	const node = el('span', `badge ${size}`, entityLetter(name));
	node.style.background = color ?? entityColor(name);
	return node;
}

// Live underlines and hover tooltips for known entities. Lives in the scene
// editor's mentions compartment, so pin changes can reconfigure it at
// runtime.
export function mentionExtensions(
	entities: MentionEntity[],
	options: MentionOptions = {}
): Extension {
	const targets: MentionTarget[] = entities.map((entity) => ({
		id: entity.id,
		type: entity.type,
		names: [entity.name, ...entity.aliases]
	}));
	const byId = new Map(entities.map((entity) => [entity.id, entity]));
	const context: MentionContext = {
		storyMembers: new Set(options.storyMembers ?? []),
		pins: new Map(Object.entries(options.pins ?? {}))
	};

	function compute(view: EditorView): DecorationSet {
		const matches = detectMentions(view.state.doc.toString(), targets, context);
		return Decoration.set(
			matches.map((match) =>
				Decoration.mark({
					class: match.candidates ? 'ref-word ref-ambiguous' : 'ref-word',
					// A known entity's name is spelled the way its author chose;
					// the browser's spellchecker keeps its squiggle off it.
					attributes: { 'data-entity': match.targetId, spellcheck: 'false' }
				}).range(match.position, match.position + match.length)
			),
			true
		);
	}

	const underlines = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = compute(view);
			}
			update(update: ViewUpdate) {
				if (update.docChanged) this.decorations = compute(update.view);
			}
		},
		{ decorations: (value) => value.decorations }
	);

	const tooltips = hoverTooltip((view, pos) => {
		// Reads the underline plugin's decorations instead of re-running
		// detection over the whole document on every hover.
		const plugin = view.plugin(underlines);
		if (!plugin) return null;
		let match: { from: number; to: number; targetId: string } | undefined;
		plugin.decorations.between(pos, pos, (from, to, decoration) => {
			match = { from, to, targetId: decoration.spec.attributes?.['data-entity'] ?? '' };
			return false;
		});
		if (!match) return null;
		const entity = byId.get(match.targetId);
		if (!entity) return null;
		const text = view.state.sliceDoc(match.from, match.to);
		// The same string on another entity makes the mention ambiguous; the
		// tooltip offers the alternatives.
		const others = entities.filter(
			(candidate) =>
				candidate.id !== entity.id && (candidate.name === text || candidate.aliases.includes(text))
		);
		const { from, to } = match;
		return {
			pos: from,
			end: to,
			above: true,
			create: () => {
				// The prototype's RPG-style entity card: badge and kind line,
				// summary, fact chips, related chips, and the way to the full
				// page. The pop-* classes are the ported design system's.
				const dom = el('div', 'entity-card');
				const head = el('div', 'pop-head');
				head.appendChild(badge(entity.name, entity.color, 'sm'));
				const id = el('div', 'pop-id');
				id.appendChild(el('div', 'pop-name', entity.name));
				const kind = entity.categoryName
					? `${KIND_LABELS[entity.type]} · ${entity.categoryName}`
					: KIND_LABELS[entity.type];
				id.appendChild(el('div', 'pop-role', kind));
				head.appendChild(id);
				dom.appendChild(head);
				if (entity.summaryMd) {
					dom.appendChild(el('div', 'pop-summary', entity.summaryMd));
				}
				const details = entity.details ?? [];
				if (details.length > 0) {
					const fields = el('div', 'pop-fields');
					for (const detail of details.slice(0, TOOLTIP_DETAILS)) {
						const field = el('div', 'pop-field');
						field.appendChild(el('span', 'pop-field-k', detail.label));
						field.appendChild(el('span', 'pop-field-v', detail.value));
						fields.appendChild(field);
					}
					dom.appendChild(fields);
				}
				const related = entity.related ?? [];
				if (related.length > 0) {
					const chips = el('div', 'pop-related');
					for (const other of related.slice(0, TOOLTIP_RELATED)) {
						const chip = el('span', 'pop-chip');
						chip.appendChild(badge(other.name, other.color, 'dot'));
						chip.appendChild(document.createTextNode(` ${other.name}`));
						chips.appendChild(chip);
					}
					dom.appendChild(chips);
				}
				if (options.onOpenCard || options.entityHref) {
					const open = el('a', 'pop-open', 'Open full details') as HTMLAnchorElement;
					if (options.entityHref) {
						open.href = options.entityHref({ type: entity.type, id: entity.id });
					}
					if (options.onOpenCard) {
						const entityId = entity.id;
						open.addEventListener('click', (event) => {
							event.preventDefault();
							options.onOpenCard!(entityId);
						});
					}
					dom.appendChild(open);
				}
				if (others.length > 0 && options.onPin) {
					const section = el('div', 'entity-tip-ambiguous');
					section.appendChild(el('div', 'entity-tip-ambiguous-label', `"${text}" also matches`));
					for (const other of others) {
						const pick = el(
							'button',
							'entity-tip-pick',
							`${other.name} (${TYPE_LABELS[other.type]}) - use here`
						) as HTMLButtonElement;
						pick.type = 'button';
						pick.addEventListener('click', () => {
							options.onPin?.(text, { type: other.type, id: other.id });
						});
						section.appendChild(pick);
					}
					dom.appendChild(section);
				}
				return { dom };
			}
		};
	});

	return [underlines, tooltips];
}
