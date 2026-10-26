<script lang="ts">
	import Icon from './Icon.svelte';
	import { authorColor, authorInitials, roleLabel, type AuthorRef } from '$lib/review-ui';

	let { author, size = 26 }: { author: AuthorRef; size?: number } = $props();

	// The owner's tile carries white initials, so it takes the darker accent
	// fill rather than the accent text shade, which is the raw accent in dark.
	const color = $derived(author.isOwner ? 'var(--accent-fill)' : authorColor(author));
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
