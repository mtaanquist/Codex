<script lang="ts">
	import type { Snippet } from 'svelte';
	import AppBar from './AppBar.svelte';
	import ReaderFooter from './ReaderFooter.svelte';

	// The one public shell: the bar reduced to the brand and two tools, one
	// centred card, and the reading pages' footer. Every signed-out page wears
	// it, so sign-in, sign-up and the pages an email link lands on are visibly
	// the same surface as the landing page.
	let {
		title,
		sub,
		children,
		aside
	}: {
		title: string;
		// One line under the title saying where the visitor is.
		sub?: string;
		children: Snippet;
		// A sentence under the card, outside it. Sign-in and sign-up use it to
		// point at self-hosting.
		aside?: Snippet;
	} = $props();
</script>

<div class="public-surface">
	<AppBar shell="public" />

	<main class="auth-main">
		<div>
			<div class="auth-card">
				<h1 class="auth-title">{title}</h1>
				{#if sub}<p class="auth-sub">{sub}</p>{/if}
				{@render children()}
			</div>
			{#if aside}
				<p class="auth-aside">{@render aside()}</p>
			{/if}
		</div>
	</main>

	<ReaderFooter shell="public" />
</div>
