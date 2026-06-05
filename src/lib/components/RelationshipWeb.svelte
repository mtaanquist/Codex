<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { entityColor } from '$lib/entity-color';
	import {
		buildWeb,
		layoutWeb,
		webCategories,
		type WebEntity,
		type WebLink
	} from '$lib/relationship-web';

	// Force-directed rendering of the universe's relationships. The layout is
	// computed synchronously per filter change; nodes link into the plan.
	let {
		entities,
		links,
		entityHref
	}: {
		entities: WebEntity[];
		links: WebLink[];
		entityHref: (id: string) => string;
	} = $props();

	const WIDTH = 800;
	const HEIGHT = 520;

	const CATEGORY_LABELS: Record<string, string> = {
		family: 'Family',
		social: 'Social',
		geography: 'Geography',
		other: 'Other'
	};

	const available = $derived(webCategories(links));
	// Empty selection = everything.
	const selectedCategories = new SvelteSet<string>();
	let focusId = $state('');
	let hoveredId = $state<string | null>(null);

	function toggleCategory(category: string) {
		if (selectedCategories.has(category)) selectedCategories.delete(category);
		else selectedCategories.add(category);
	}

	const web = $derived(
		buildWeb(entities, links, {
			categories: selectedCategories,
			focusId: focusId || null
		})
	);
	const placed = $derived(layoutWeb(web.nodes, web.links, WIDTH, HEIGHT));

	// Entities that can be focused: anything connected at all.
	const focusOptions = $derived(buildWeb(entities, links).nodes);

	function nodeRadius(degree: number): number {
		return Math.min(16, 7 + degree * 1.5);
	}

	function dimmed(nodeOrLinkIds: string[]): boolean {
		return hoveredId !== null && !nodeOrLinkIds.includes(hoveredId);
	}
</script>

{#if links.length === 0}
	<p class="web-empty">
		No relationships yet. Add them on an entity's page in the Plan view, and the web draws itself
		here.
	</p>
{:else}
	<div class="web-filters">
		{#each available as category (category)}
			<button
				type="button"
				class="chip"
				class:active={selectedCategories.has(category)}
				onclick={() => toggleCategory(category)}
			>
				{CATEGORY_LABELS[category] ?? category}
			</button>
		{/each}
		<select class="web-focus" bind:value={focusId} aria-label="Focus on entity">
			<option value="">Whole universe</option>
			{#each focusOptions as option (option.id)}
				<option value={option.id}>{option.name}</option>
			{/each}
		</select>
	</div>
	{#if placed.nodes.length === 0}
		<p class="web-empty">Nothing matches these filters.</p>
	{:else}
		<svg
			class="web"
			viewBox="0 0 {WIDTH} {HEIGHT}"
			role="img"
			aria-label="Relationship web: entities connected by their relationships"
		>
			{#each placed.links as link (link.id)}
				<line
					class="web-link"
					class:dim={dimmed([link.fromId, link.toId])}
					x1={link.x1}
					y1={link.y1}
					x2={link.x2}
					y2={link.y2}
				>
					<title>{link.label}</title>
				</line>
			{/each}
			{#each placed.links as link (`label-${link.id}`)}
				{#if !dimmed( [link.fromId, link.toId] ) && (hoveredId === link.fromId || hoveredId === link.toId)}
					<text class="web-link-label" x={(link.x1 + link.x2) / 2} y={(link.y1 + link.y2) / 2 - 4}>
						{link.label}
					</text>
				{/if}
			{/each}
			{#each placed.nodes as node (node.id)}
				<!-- eslint-disable svelte/no-navigation-without-resolve (caller resolves the path) -->
				<a
					href={entityHref(node.id)}
					onmouseenter={() => (hoveredId = node.id)}
					onmouseleave={() => (hoveredId = null)}
				>
					<g class="web-node" class:dim={dimmed([node.id])}>
						<circle
							cx={node.x}
							cy={node.y}
							r={nodeRadius(node.degree)}
							fill={node.color ?? entityColor(node.name)}
						/>
						<text class="web-name" x={node.x} y={node.y + nodeRadius(node.degree) + 13}>
							{node.name}
						</text>
						<title
							>{node.name}: {node.degree}
							{node.degree === 1 ? 'relationship' : 'relationships'}</title
						>
					</g>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
		</svg>
	{/if}
{/if}

<style>
	.web-filters {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 10px;
	}
	.web-filters .chip.active {
		border-color: var(--accent);
		color: var(--accent);
	}
	.web-focus {
		margin-left: auto;
		font-family: var(--font-ui);
		font-size: 12.5px;
		color: var(--text);
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		padding: 4px 8px;
	}
	.web {
		display: block;
		width: 100%;
		height: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		background: var(--bg-elevated);
	}
	.web-link {
		stroke: var(--border);
		stroke-width: 1.5;
	}
	.web-link.dim {
		opacity: 0.25;
	}
	.web-link-label {
		font-family: var(--font-ui);
		font-size: 11px;
		fill: var(--text-muted);
		text-anchor: middle;
		pointer-events: none;
	}
	.web-node.dim {
		opacity: 0.3;
	}
	.web-node circle {
		stroke: var(--bg-elevated);
		stroke-width: 2;
	}
	.web-name {
		font-family: var(--font-ui);
		font-size: 12px;
		fill: var(--text);
		text-anchor: middle;
	}
	.web-empty {
		color: var(--text-muted);
		font-size: 13px;
		margin: 0;
	}
</style>
