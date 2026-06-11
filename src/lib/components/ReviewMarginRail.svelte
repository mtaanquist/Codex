<script lang="ts">
	import Icon from './Icon.svelte';

	// The margin rail of jump markers beside the review prose, shared by the
	// editor and the read-only surface. The caller computes and nudges the
	// positions (review-ui's nudgeMarkers).
	let {
		markers,
		focusedId,
		setFocused
	}: {
		markers: { id: string; kind: string; color: string; top: number }[];
		focusedId: string | null;
		setFocused: (id: string | null) => void;
	} = $props();
</script>

<div class="review-rail" aria-hidden="true">
	{#each markers as marker (marker.id)}
		<button
			class="rv-marker"
			class:is-focused={focusedId === marker.id}
			style="top: {marker.top}px; --auth: {marker.color};"
			type="button"
			onclick={() => setFocused(marker.id)}
			title="Jump to this note"
		>
			<Icon name={marker.kind === 'comment' ? 'comment' : 'suggest'} size={13} />
		</button>
	{/each}
</div>
