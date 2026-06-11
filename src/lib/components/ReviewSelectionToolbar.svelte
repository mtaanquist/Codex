<script lang="ts">
	import Icon from './Icon.svelte';

	// The floating comment/suggest toolbar over a text selection, shared by
	// the review editor and the read-only surface.
	let {
		left,
		top,
		canSuggest,
		onComment,
		onSuggest
	}: {
		left: number;
		top: number;
		canSuggest: boolean;
		onComment: () => void;
		onSuggest: () => void;
	} = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="rv-seltool"
	style="left: {left}px; top: {top}px;"
	onmousedown={(e) => e.preventDefault()}
>
	<button type="button" onclick={onComment}>
		<Icon name="comment-plus" size={15} /> Comment
	</button>
	{#if canSuggest}
		<span class="rv-seltool-sep"></span>
		<button type="button" onclick={onSuggest}>
			<Icon name="suggest" size={15} /> Suggest edit
		</button>
	{/if}
</div>
