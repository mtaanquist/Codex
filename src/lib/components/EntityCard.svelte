<script lang="ts">
	import { renderMarkdown } from '$lib/markdown';
	import { entityColor, entityLetter } from '$lib/entity-color';
	import Icon from './Icon.svelte';
	import EntityBadge from './EntityBadge.svelte';
	import type { EntityCardData } from '$lib/server/plan-data';

	// The read-only entity card that takes over the editor's right column:
	// summary, description, typed relationships, details, and a link into the
	// plan. Relationships open another card in the same frame; Back walks the
	// stack the page keeps.
	let {
		card,
		onBack,
		onOpen,
		planHref
	}: {
		card: EntityCardData;
		// Walks the card stack; from the first card it returns to the tabs.
		onBack: () => void;
		onOpen: (entityId: string) => void;
		planHref: string;
	} = $props();

	const kindLabel = $derived(
		card.kind === 'place' ? 'Place' : card.kind === 'lore' ? 'Lore' : 'Character'
	);
</script>

<div class="inspector">
	<div class="inspector-head">
		<button class="back-btn" type="button" onclick={onBack}>
			<Icon name="chevron" size={13} /> Back
		</button>
		<span class="inspector-kind">{kindLabel}</span>
	</div>
	<div class="inspector-scroll">
		<div class="insp-id">
			<EntityBadge
				name={card.name}
				badgeColor={card.badgeColor}
				badgeAssetId={card.badgeAssetId}
				categoryColor={card.categoryColor}
				size="lg"
			/>
			<div>
				<div class="insp-name">{card.name}</div>
				{#if card.categoryName}<div class="insp-role">{card.categoryName}</div>{/if}
			</div>
		</div>

		{#if card.aliases.length > 0}
			<div class="insp-aliases">
				{#each card.aliases as alias (alias)}
					<span class="chip">{alias}</span>
				{/each}
			</div>
		{/if}

		{#if card.summaryMd}
			<div class="insp-summary">{card.summaryMd}</div>
		{/if}

		{#if card.bodyMd.trim()}
			<div class="insp-label">Description</div>
			<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
			<div class="insp-desc">{@html renderMarkdown(card.bodyMd)}</div>
		{/if}

		{#if card.related.length > 0}
			<div class="insp-label">Relationships</div>
			<div class="insp-rels">
				{#each card.related as relation (relation.id + relation.label)}
					<button class="insp-rel" type="button" onclick={() => onOpen(relation.id)}>
						<span class="insp-rel-type">{relation.label}</span>
						<span class="badge dot" style="background: {entityColor(relation.name)}">
							{entityLetter(relation.name)}
						</span>
						<span class="insp-rel-name">{relation.name}</span>
					</button>
				{/each}
			</div>
		{/if}

		{#if card.details.length > 0}
			<div class="insp-label">Details</div>
			<div class="insp-fields">
				{#each card.details as field (field.label)}
					<div class="insp-field">
						<span class="insp-field-k">{field.label}</span>
						<span class="insp-field-v">{field.value}</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
		<a class="insp-open" href={planHref}>Open in Plan view &#8599;</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</div>
</div>

<style>
	.inspector {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.inspector-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}
	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 0;
		background: none;
		color: var(--text-muted);
		font-size: 13px;
		font-weight: 600;
		padding: 5px 8px;
		border-radius: 7px;
	}
	.back-btn :global(svg) {
		transform: rotate(180deg);
	}
	.back-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.inspector-kind {
		font-size: 10.5px;
		font-weight: 650;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.inspector-scroll {
		flex: 1;
		overflow: auto;
		padding: 16px;
	}
	.insp-id {
		display: flex;
		align-items: center;
		gap: 11px;
		margin-bottom: 14px;
	}
	.insp-name {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 600;
		line-height: 1.1;
	}
	.insp-role {
		font-size: 12.5px;
		color: var(--text-muted);
		margin-top: 2px;
	}
	.insp-aliases {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 14px;
	}
	.insp-summary {
		font-family: var(--font-content);
		font-size: 15px;
		line-height: 1.55;
		color: var(--text);
	}
	.insp-label {
		font-size: 10.5px;
		font-weight: 650;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin: 20px 0 9px;
	}
	.insp-desc {
		font-family: var(--font-content);
		font-size: 14px;
		line-height: 1.6;
		color: var(--text-muted);
	}
	.insp-desc :global(p) {
		margin: 0 0 0.8em;
	}
	.insp-rels {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.insp-rel {
		display: flex;
		align-items: center;
		gap: 8px;
		border: 1px solid var(--border);
		background: var(--bg-inset);
		border-radius: 8px;
		padding: 8px 10px;
		text-align: left;
		cursor: pointer;
	}
	.insp-rel:hover {
		border-color: var(--border-strong);
	}
	.insp-rel-type {
		font-size: 10px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
		min-width: 62px;
	}
	.insp-rel-name {
		font-size: 13.5px;
		color: var(--text);
	}
	.insp-rel:hover .insp-rel-name {
		color: var(--accent);
	}
	.insp-fields {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1px;
		background: var(--border);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.insp-field {
		background: var(--bg);
		padding: 9px 11px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.insp-field-k {
		font-size: 10px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.insp-field-v {
		font-size: 13px;
		color: var(--text);
	}
	.insp-open {
		display: inline-block;
		margin-top: 22px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
		white-space: nowrap;
	}
	.insp-open:hover {
		text-decoration: underline;
	}
</style>
