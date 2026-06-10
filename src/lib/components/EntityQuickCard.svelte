<script lang="ts">
	import EntityBadge from './EntityBadge.svelte';
	import type { MentionEntity } from '$lib/editor-mentions';

	// The read-only quick card shown when a mention is clicked in the review
	// surface - the same fields the editor's hover card shows, never the full
	// entity. The "Open full details" link appears only when a href is given
	// (the author's own review); a guest never gets one.
	let { entity, href = null }: { entity: MentionEntity; href?: string | null } = $props();

	const KIND_LABELS = { character: 'Character', place: 'Place', lore_entry: 'Lore' } as const;
	const kind = $derived(
		entity.categoryName
			? `${KIND_LABELS[entity.type]} - ${entity.categoryName}`
			: KIND_LABELS[entity.type]
	);
</script>

<div class="entity-card">
	<div class="pop-head">
		<EntityBadge
			name={entity.name}
			badgeColor={entity.badgeColor}
			badgeAssetId={entity.badgeAssetId}
			categoryColor={entity.color}
			size="sm"
		/>
		<div class="pop-id">
			<div class="pop-name">{entity.name}</div>
			<div class="pop-role">{kind}</div>
		</div>
	</div>
	{#if entity.summaryMd}
		<div class="pop-summary">{entity.summaryMd}</div>
	{/if}
	{#if entity.details && entity.details.length > 0}
		<div class="pop-fields">
			{#each entity.details.slice(0, 3) as detail (detail.label)}
				<div class="pop-field">
					<span class="pop-field-k">{detail.label}</span>
					<span class="pop-field-v">{detail.value}</span>
				</div>
			{/each}
		</div>
	{/if}
	{#if entity.related && entity.related.length > 0}
		<div class="pop-related">
			{#each entity.related.slice(0, 4) as other (other.name)}
				<span class="pop-chip">
					<EntityBadge name={other.name} categoryColor={other.color} size="dot" />
					{other.name}
				</span>
			{/each}
		</div>
	{/if}
	{#if href}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the path) -->
		<a class="pop-open" {href}>Open full details</a>
	{/if}
</div>
