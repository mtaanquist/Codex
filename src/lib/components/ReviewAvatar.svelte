<script lang="ts">
	import Icon from './Icon.svelte';
	import { authorColor, authorInitials, type AuthorRef } from '$lib/review-ui';

	let { author, size = 26 }: { author: AuthorRef; size?: number } = $props();

	const color = $derived(authorColor(author));
	const role = $derived(author.isAssistant ? 'Assistant' : author.isOwner ? 'Author' : 'Reviewer');
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
