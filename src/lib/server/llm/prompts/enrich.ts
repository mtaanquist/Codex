import type { EntityKind } from '$lib/components/EntityEditor.svelte';

// The enrichment instruction: from where an entity appears in the prose, suggest
// new aliases, quick details, and (only when it has none) a summary. The reply
// must be a single JSON object so the job can stage each field as a suggestion
// the writer accepts or rejects. The gateway prepends the persona message; this
// is the task turn. No tools. Shipped-fixed in v1 (see assistant.md).

export type EnrichEntity = {
	kind: EntityKind;
	name: string;
	aliases: string[];
	details: { label: string; value: string }[];
	summaryMd: string | null;
	hasSummary: boolean;
};

export function buildEnrichMessage(entity: EnrichEntity, appearances: string[]): string {
	const aliasWord = entity.kind === 'lore' ? 'keywords' : 'aliases';
	const known =
		entity.aliases.length || entity.details.length
			? [
					entity.aliases.length ? `Known ${aliasWord}: ${entity.aliases.join(', ')}.` : '',
					...entity.details.map((d) => `Known detail - ${d.label}: ${d.value}`)
				]
					.filter(Boolean)
					.join('\n')
			: 'No aliases or details recorded yet.';

	const lines = [
		`Enrich the ${entity.kind === 'lore' ? 'lore entry' : entity.kind} "${entity.name}" from how it appears in the prose.`,
		known,
		'',
		'Passages where it appears:',
		appearances.length ? appearances.map((a, i) => `${i + 1}. ${a}`).join('\n') : '(none found)',
		'',
		'Suggest only what the passages support, grounded in the text, never invented:',
		`- new ${aliasWord} actually used for it that are not already listed,`,
		'- factual quick details (a label and a short value, like "Eyes: grey" or "Role: harbourmaster") not already recorded,',
		entity.hasSummary
			? '- do not propose a summary; it already has one.'
			: '- a one or two sentence summary of who or what it is.',
		'',
		'Reply with only a JSON object, no prose around it, in this exact shape:',
		'{"aliases": ["..."], "details": [{"label": "...", "value": "..."}], "summary": "..."}',
		entity.hasSummary
			? 'Use "summary": null. Use empty arrays where you have nothing to add.'
			: 'Use "summary": null if you cannot summarise it. Use empty arrays where you have nothing to add.'
	];
	return lines.join('\n');
}
