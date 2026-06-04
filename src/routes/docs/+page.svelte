<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Help - Codex</title>
</svelte:head>

<main class="docs">
	<a class="back" href={resolve('/')}>Back to your library</a>
	<h1>Help</h1>
	<p class="lede">Short guides to the parts of Codex. Pick a topic to get started.</p>
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
	h1 {
		font-family: var(--font-serif);
		margin: 1rem 0 0.25rem;
	}
	.lede {
		color: var(--text-muted);
		margin: 0 0 1.75rem;
	}
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
