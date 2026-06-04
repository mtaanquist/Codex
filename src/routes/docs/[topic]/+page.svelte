<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.article.title} - Help - Codex</title>
</svelte:head>

<main class="docs">
	<a class="back" href={resolve('/docs')}>All help</a>
	<!-- Trusted, committed markdown; renderMarkdown also escapes raw HTML. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<article class="prose">{@html renderMarkdown(data.article.body)}</article>

	<nav class="more">
		<h2>More help</h2>
		<ul>
			{#each data.topics.filter((t) => t.slug !== data.article.slug) as topic (topic.slug)}
				<li><a href={resolve('/docs/[topic]', { topic: topic.slug })}>{topic.title}</a></li>
			{/each}
		</ul>
	</nav>
</main>

<style>
	.docs {
		max-width: 44rem;
		margin: 0 auto;
		padding: 3rem 1.25rem 5rem;
		color: var(--text);
	}
	.back {
		font-size: 0.9rem;
		color: var(--text-muted);
	}
	.prose {
		font-family: var(--font-serif);
		line-height: 1.7;
		margin-top: 1rem;
	}
	.prose :global(h1) {
		font-size: 1.7rem;
		margin: 0.5rem 0 1rem;
	}
	.prose :global(h2) {
		font-size: 1.2rem;
		margin: 1.75rem 0 0.5rem;
	}
	.prose :global(p),
	.prose :global(li) {
		color: var(--text);
	}
	.prose :global(ul),
	.prose :global(ol) {
		padding-left: 1.4rem;
	}
	.prose :global(li) {
		margin: 0.3rem 0;
	}
	.prose :global(strong) {
		font-weight: 600;
	}
	.prose :global(code) {
		font-family: var(--font-mono);
		font-size: 0.9em;
		background: var(--bg-inset);
		padding: 0.1em 0.35em;
		border-radius: var(--radius-sm);
	}
	.more {
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}
	.more h2 {
		font-size: 0.95rem;
		color: var(--text-muted);
		margin: 0 0 0.5rem;
	}
	.more ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.25rem;
	}
	.more a {
		color: var(--accent);
	}
</style>
