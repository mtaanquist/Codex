import {
	Decoration,
	EditorView,
	hoverTooltip,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { detectMentions, type MentionTarget } from './mention-detect';

export type MentionEntity = {
	id: string;
	name: string;
	aliases: string[];
	summaryMd: string | null;
	details?: { label: string; value: string }[];
};

// The tooltip shows the first few quick details; the rest live on the
// entity's page. Order is the author's, so the top ones are theirs to pick.
const TOOLTIP_DETAILS = 3;

// Live underlines and hover tooltips for known entities. Lives in the scene
// editor's mentions compartment, so the future "Underline known entities"
// setting can reconfigure it at runtime.
export function mentionExtensions(entities: MentionEntity[]): Extension {
	const targets: MentionTarget[] = entities.map((entity) => ({
		id: entity.id,
		type: 'character',
		names: [entity.name, ...entity.aliases]
	}));
	const byId = new Map(entities.map((entity) => [entity.id, entity]));

	function compute(view: EditorView): DecorationSet {
		const matches = detectMentions(view.state.doc.toString(), targets);
		return Decoration.set(
			matches.map((match) =>
				Decoration.mark({
					class: 'ref-word',
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
		return {
			pos: match.from,
			end: match.to,
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
				return { dom };
			}
		};
	});

	return [underlines, tooltips];
}
