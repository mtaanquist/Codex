<script lang="ts">
	import Icon from './Icon.svelte';

	// The scene header shared by the review centre's two faces (the author's
	// editor and the guest's read-only surface): kicker, title, and the open
	// activity chips.
	let {
		chapterTitle,
		sceneTitle,
		openComments,
		openSuggestions
	}: {
		chapterTitle: string;
		sceneTitle: string | null;
		openComments: number;
		openSuggestions: number;
	} = $props();
</script>

<div class="review-head">
	<div class="review-kicker">{chapterTitle} - review</div>
	<h1 class="review-title">{sceneTitle ?? 'Untitled scene'}</h1>
	<div class="review-subline">
		{#if openComments + openSuggestions === 0}
			No open review activity in this scene.
		{:else}
			{#if openComments > 0}
				<span class="rv-sub-chip">
					<Icon name="comment" size={13} />
					{openComments}
					{openComments === 1 ? 'comment' : 'comments'}
				</span>
			{/if}
			{#if openSuggestions > 0}
				<span class="rv-sub-chip">
					<Icon name="suggest" size={13} />
					{openSuggestions}
					{openSuggestions === 1 ? 'suggestion' : 'suggestions'}
				</span>
			{/if}
		{/if}
	</div>
</div>
