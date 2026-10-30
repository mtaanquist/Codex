<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import AppBar from './AppBar.svelte';
	import { helpFrom } from '#lib/help.svelte';
	import { pageCrumb, type Crumb, LEFT_PANE_LABEL } from '#lib/chrome';
	import type { DocTopic } from '#lib/docs';

	// Help is one presentation: a page inside the chrome, with the article list
	// as the left pane, so an article is never a bare page floating outside the
	// app.
	let {
		topics,
		active,
		children
	}: {
		topics: DocTopic[];
		// The article being read; absent on the index.
		active?: { slug: string; title: string };
		children: Snippet;
	} = $props();

	const crumbs = $derived<Crumb[]>(
		active
			? [{ kind: 'link', label: 'Help', href: resolve('/docs') }, pageCrumb(active.title)]
			: [pageCrumb('Help')]
	);

	// Where the reader came from, so the sidebar can offer the way back.
	const back = $derived(helpFrom());
</script>

<div class="app docs">
	<AppBar {crumbs} helpTopic={active?.slug} helpLabel="Codex" />
	<div class="body no-right">
		<aside class="pane left" aria-label={LEFT_PANE_LABEL}>
			<div class="side-head">
				<div>
					<div class="side-head-title">Help</div>
					<div class="side-head-sub">Short guides to the parts of Codex</div>
				</div>
			</div>
			<div class="left-scroll">
				<nav class="side-nav" aria-label="Help topics">
					{#each topics as topic (topic.slug)}
						<a
							href={resolve('/docs/[topic]', { topic: topic.slug })}
							aria-current={topic.slug === active?.slug ? 'page' : undefined}
						>
							{topic.title}
						</a>
					{/each}
				</nav>
				{#if back || page.data.user}
					<div class="side-nav-label" id="docs-back-label">Back to your work</div>
					<nav class="side-nav" aria-labelledby="docs-back-label">
						{#if back}<a href={back}>Where you were</a>{/if}
						{#if page.data.user}<a href={resolve('/')}>Your library</a>{/if}
					</nav>
				{/if}
			</div>
		</aside>
		<main id="main" class="pane center">
			<div class="docs-body">
				{@render children()}
			</div>
		</main>
	</div>
</div>

<style>
	.docs-body {
		max-width: 44rem;
		margin: 0 auto;
		padding: var(--space-8) var(--space-8) 90px;
	}
	/* On a phone the topic list sits above the article and the page scrolls
	   as one, instead of two side-by-side scrolling columns. */
	@media (max-width: 760px) {
		.app.docs {
			height: auto;
			min-height: 100vh;
			grid-template-rows: auto 1fr;
		}
		.app.docs .body {
			grid-template-columns: 1fr;
		}
		.pane {
			overflow: visible;
		}
		.pane.left {
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		.docs-body {
			padding: var(--space-6) var(--space-4) 60px;
		}
	}
</style>
