<script lang="ts">
	import { renderMarkdown } from '$lib/markdown';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function chapterScenes(chapterId: string | null) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}
</script>

<svelte:head>
	<title>{data.story.title} - Print - Codex</title>
</svelte:head>

<div class="print-page">
	<div class="print-controls no-print">
		<p>Use Print and choose "Save as PDF" to export this story.</p>
		<button type="button" onclick={() => window.print()}>Print</button>
	</div>

	<header class="title-page">
		<h1>{data.story.title}</h1>
		{#if data.story.author}<p class="author">{data.story.author}</p>{/if}
	</header>

	{#each data.chapters as chapter, index (chapter.id)}
		{@const list = chapterScenes(chapter.id)}
		{#if list.length > 0}
			<section class="chapter">
				<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
				{#each list as scene, si (scene.id)}
					{#if si > 0}<hr class="scene-break" />{/if}
					<!-- Prose renders through the shared markdown renderer; raw HTML
					     is escaped there, so this stays the author's words only. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html renderMarkdown(scene.bodyMd)}
				{/each}
			</section>
		{/if}
	{/each}
	{#if chapterScenes(null).length > 0}
		<section class="chapter">
			<h2>Unfiled scenes</h2>
			{#each chapterScenes(null) as scene, si (scene.id)}
				{#if si > 0}<hr class="scene-break" />{/if}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html renderMarkdown(scene.bodyMd)}
			{/each}
		</section>
	{/if}
</div>

<style>
	.print-page {
		max-width: 42rem;
		margin: 0 auto;
		padding: 2rem 1rem;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 12pt;
		line-height: 1.6;
		color: #000;
		background: #fff;
	}
	.print-controls {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		border-bottom: 1px solid #ccc;
		padding-bottom: 1rem;
		margin-bottom: 2rem;
		font-family: system-ui, sans-serif;
		font-size: 10pt;
	}
	.title-page {
		text-align: center;
		margin: 4rem 0 6rem;
	}
	.title-page h1 {
		font-size: 28pt;
		font-weight: 600;
	}
	.author {
		margin-top: 1rem;
		font-size: 14pt;
	}
	.chapter h2 {
		text-align: center;
		font-size: 18pt;
		margin: 3rem 0 2rem;
	}
	.scene-break {
		border: 0;
		text-align: center;
		margin: 2rem 0;
	}
	.scene-break::after {
		content: '* * *';
		color: #444;
	}
	.chapter :global(p) {
		margin: 0 0 0.2rem;
		text-indent: 1.5em;
	}
	.chapter :global(img) {
		max-width: 100%;
	}

	@page {
		margin: 2cm;
	}
	@media print {
		.no-print {
			display: none;
		}
		.title-page {
			page-break-after: always;
		}
		.chapter {
			page-break-before: always;
		}
		.print-page {
			padding: 0;
			max-width: none;
		}
	}
</style>
