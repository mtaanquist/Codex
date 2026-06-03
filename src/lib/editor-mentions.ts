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
};

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
		const match = detectMentions(view.state.doc.toString(), targets).find(
			(candidate) => pos >= candidate.position && pos <= candidate.position + candidate.length
		);
		if (!match) return null;
		const entity = byId.get(match.targetId);
		if (!entity) return null;
		return {
			pos: match.position,
			end: match.position + match.length,
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
				return { dom };
			}
		};
	});

	return [underlines, tooltips];
}
