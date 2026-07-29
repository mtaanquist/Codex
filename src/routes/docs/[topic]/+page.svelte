<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import DocsShell from '$lib/components/DocsShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The next article in the registry order, so reading straight through works.
	const next = $derived.by(() => {
		const at = data.topics.findIndex((topic) => topic.slug === data.article.slug);
		return at >= 0 ? data.topics[at + 1] : undefined;
	});
</script>

<svelte:head>
	<title>{data.article.title} - Help - Codex</title>
</svelte:head>

<DocsShell topics={data.topics} active={data.article}>
	<div class="kicker">Help</div>
	<!-- Trusted, committed markdown; renderMarkdown also escapes raw HTML. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<article class="prose">{@html renderMarkdown(data.article.body)}</article>

	{#if next}
		<nav class="more">
			<a class="btn btn-secondary" href={resolve('/docs/[topic]', { topic: next.slug })}>
				Next: {next.title}
			</a>
		</nav>
	{/if}
</DocsShell>

<style>
	.kicker {
		font-size: var(--text-micro);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin-bottom: 6px;
	}
	.prose {
		font-family: var(--font-serif);
		line-height: 1.7;
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
		margin-top: var(--space-10);
		padding-top: var(--space-5);
		border-top: 1px solid var(--border);
	}
</style>
