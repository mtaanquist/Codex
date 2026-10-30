<script lang="ts">
	import Icon from './Icon.svelte';
	import { authorColor, authorInitials, roleLabel, type AuthorRef } from '#lib/review-ui';

	let { author, size = 26 }: { author: AuthorRef; size?: number } = $props();

	// The tile carries white initials, so it takes a darkened fill: the accent
	// fill for the owner, and the author colour mixed towards black for the
	// rest (the raw palette colours are too light for white text).
	const color = $derived(
		author.isOwner ? 'var(--accent-fill)' : `color-mix(in oklab, ${authorColor(author)} 65%, black)`
	);
	const role = $derived(roleLabel(author));
</script>

<span
	class="rv-av"
	style="background: {color}; width: {size}px; height: {size}px; font-size: {Math.round(
		size * 0.42
	)}px;"
	title="{author.name} - {role}"
>
	{#if author.isAssistant}
		<Icon name="sparkles" size={Math.round(size * 0.56)} fill />
	{:else}
		{authorInitials(author.name)}
	{/if}
</span>
