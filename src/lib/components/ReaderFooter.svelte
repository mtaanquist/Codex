<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';

	// The one footer both reading pages carry: the mark, who published the work,
	// and three links. It is the only brand statement on the page, and it sits at
	// the end where a reader who has finished will find it.
	let {
		author,
		shelfHref,
		belongs = 'story'
	}: {
		// The author's name for the reader (pen name, else display name).
		author: string;
		shelfHref: string;
		// 'story' says who published this story; 'shelf' says whose shelf this is.
		belongs?: 'story' | 'shelf';
	} = $props();
</script>

<footer class="reader-foot">
	<div class="reader-foot-in">
		<span class="reader-foot-brand">
			<span class="logo"><Icon name="feather" size={15} /></span>
			Written in Codex
		</span>
		{#if author}
			<span>
				{belongs === 'shelf' ? 'This shelf belongs to' : 'Published by'}
				<a href={shelfHref}>{author}</a>
			</span>
		{/if}
		<span class="reader-foot-links">
			<a href={resolve('/docs/[topic]', { topic: 'publishing' })}>Reading in Codex</a>
			<a href={resolve('/docs')}>About Codex</a>
			<!-- The library for a signed-in reader, the sign-in page otherwise. -->
			<a href={resolve('/')}>Write your own</a>
		</span>
	</div>
</footer>

<style>
	/* The brand mark is a filled tile, so its stroke icon is always white. */
	.logo :global(svg) {
		color: #fff;
	}
</style>
