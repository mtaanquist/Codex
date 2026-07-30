<script lang="ts">
	import { resolve } from '$app/paths';
	import DocsShell from '$lib/components/DocsShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Help - Codex</title>
</svelte:head>

<DocsShell topics={data.topics}>
	<div class="page-header">
		<div>
			<h1 class="page-title">Help</h1>
			<p class="page-subtitle">Short guides to the parts of Codex. Pick a topic to get started.</p>
		</div>
	</div>
	<ul class="topics">
		{#each data.topics as topic (topic.slug)}
			<li>
				<a href={resolve('/docs/[topic]', { topic: topic.slug })}>
					<span class="topic-title">{topic.title}</span>
					<span class="topic-summary">{topic.summary}</span>
				</a>
			</li>
		{/each}
	</ul>
</DocsShell>

<style>
	.topics {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.75rem;
	}
	.topics a {
		display: block;
		padding: 1rem 1.1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-card);
		text-decoration: none;
		color: inherit;
	}
	.topics a:hover {
		border-color: var(--accent-line);
	}
	.topic-title {
		display: block;
		font-weight: 600;
	}
	.topic-summary {
		display: block;
		margin-top: 0.2rem;
		font-size: 0.92rem;
		color: var(--text-muted);
	}
</style>
