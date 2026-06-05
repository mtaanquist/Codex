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

export type MentionEntity = {
	id: string;
	type: MentionTarget['type'];
	name: string;
	aliases: string[];
	summaryMd: string | null;
	details?: { label: string; value: string }[];
};

export type MentionOptions = {
	// Entities declared in the story, outranking the rest on shared names.
	storyMembers?: string[];
	// The story's pins: matched text -> entity id.
	pins?: Record<string, string>;
	// Called when the author picks which entity an ambiguous name means.
	onPin?: (name: string, target: { type: MentionTarget['type']; id: string }) => void;
};

// The tooltip shows the first few quick details; the rest live on the
// entity's page. Order is the author's, so the top ones are theirs to pick.
const TOOLTIP_DETAILS = 3;

const TYPE_LABELS: Record<MentionTarget['type'], string> = {
	character: 'character',
	place: 'place',
	lore_entry: 'lore'
};

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
					attributes: { 'data-entity': match.targetId }
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
				const dom = document.createElement('div');
				dom.className = 'entity-tip';
				const name = document.createElement('div');
				name.className = 'entity-tip-name';
				name.textContent = entity.name;
				dom.appendChild(name);
				if (entity.summaryMd) {
					const summary = document.createElement('div');
					summary.className = 'entity-tip-summary';
					summary.textContent = entity.summaryMd;
					dom.appendChild(summary);
				}
				const details = entity.details ?? [];
				if (details.length > 0) {
					const grid = document.createElement('div');
					grid.className = 'entity-tip-details';
					for (const detail of details.slice(0, TOOLTIP_DETAILS)) {
						const row = document.createElement('div');
						row.className = 'entity-tip-detail';
						const label = document.createElement('span');
						label.className = 'entity-tip-detail-k';
						label.textContent = detail.label;
						const value = document.createElement('span');
						value.className = 'entity-tip-detail-v';
						value.textContent = detail.value;
						row.appendChild(label);
						row.appendChild(value);
						grid.appendChild(row);
					}
					dom.appendChild(grid);
				}
				if (others.length > 0 && options.onPin) {
					const section = document.createElement('div');
					section.className = 'entity-tip-ambiguous';
					const heading = document.createElement('div');
					heading.className = 'entity-tip-ambiguous-label';
					heading.textContent = `"${text}" also matches`;
					section.appendChild(heading);
					for (const other of others) {
						const pick = document.createElement('button');
						pick.type = 'button';
						pick.className = 'entity-tip-pick';
						pick.textContent = `${other.name} (${TYPE_LABELS[other.type]}) - use here`;
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
