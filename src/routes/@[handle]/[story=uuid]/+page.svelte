<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.title} - @{data.handle}</title>
	{#if data.gate || data.isAdult}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

{#if data.gate}
	<main class="reader gate">
		<h1>{data.title}</h1>
		{#if data.author}<p class="author">{data.author}</p>{/if}
		<p>The author marked this story as adult content.</p>
		<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
		<a
			class="continue"
			href={`${resolve('/@[handle]/[story=uuid]', { handle: data.handle, story: data.storyId })}?adult=ok`}
		>
			I am an adult; show the story
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		<p><a href={resolve('/@[handle]', { handle: data.handle })}>Back to the shelf</a></p>
	</main>
{:else}
	<main class="reader">
		<header>
			{#if data.coverAssetId}
				<img class="cover" src="/assets/{data.coverAssetId}" alt="" />
			{/if}
			<h1>{data.title}</h1>
			{#if data.author}<p class="author">{data.author}</p>{/if}
			{#if data.descriptionMd}
				<!-- Author markdown; renderMarkdown escapes raw HTML. -->
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="brief">{@html renderMarkdown(data.descriptionMd)}</div>
			{/if}
			<p class="meta">
				Published {data.publishedAt.toLocaleDateString()}
				{#if data.versionLabel}- {data.versionLabel}{/if}
				- <a href={resolve('/@[handle]', { handle: data.handle })}>@{data.handle}</a>
			</p>
			{#if data.downloads.length > 0}
				<p class="meta downloads">
					Download:
					{#each data.downloads as artifact (artifact.id)}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (file download) -->
						<a href="/artifacts/{artifact.id}" download>
							{artifact.format === 'epub' ? 'EPUB' : 'PDF'}
						</a>
					{/each}
				</p>
			{/if}
		</header>

		{#each data.content.chapters as chapter, index (index)}
			<section class="chapter">
				<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
				{#each chapter.scenes as scene, si (si)}
					{#if si > 0}<hr class="scene-break" />{/if}
					<article>
						<!-- The shared renderer escapes raw HTML, so this is the
						     author's words only. -->
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html renderMarkdown(scene.bodyMd)}
					</article>
				{/each}
			</section>
		{/each}
		{#if data.content.unfiled.length > 0}
			<section class="chapter">
				<h2>Unfiled scenes</h2>
				{#each data.content.unfiled as scene, si (si)}
					{#if si > 0}<hr class="scene-break" />{/if}
					<article>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html renderMarkdown(scene.bodyMd)}
					</article>
				{/each}
			</section>
		{/if}
	</main>
{/if}

<style>
	.reader {
		max-width: 40rem;
		margin: 0 auto;
		padding: 3rem 1rem 5rem;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 1.125rem;
		line-height: 1.7;
		color: #1a1a1a;
		background: #fff;
	}
	header {
		text-align: center;
		margin-bottom: 4rem;
	}
	.cover {
		width: 10rem;
		aspect-ratio: 2 / 3;
		object-fit: cover;
		border-radius: 6px;
		margin: 0 auto 1.5rem;
		display: block;
	}
	h1 {
		font-size: 2rem;
		margin: 0;
	}
	.author {
		font-size: 1.1rem;
		margin: 0.5rem 0 0;
	}
	.brief {
		color: #444;
		margin: 1rem 0 0;
	}
	.meta {
		font-size: 0.85rem;
		color: #555;
		margin: 1rem 0 0;
	}
	.meta a,
	.gate a {
		color: #1a4a8a;
	}
	.downloads a {
		margin-left: 0.35rem;
	}
	.meta a:focus-visible,
	.gate a:focus-visible {
		outline: 3px solid #1a4a8a;
		outline-offset: 3px;
	}
	.chapter h2 {
		text-align: center;
		font-size: 1.4rem;
		margin: 3rem 0 2rem;
	}
	.chapter :global(p) {
		margin: 0 0 0.25rem;
		text-indent: 1.5em;
	}
	.chapter :global(p:first-child) {
		text-indent: 0;
	}
	/* Aligned paragraphs; centered and right-aligned text drops the indent. */
	.chapter :global(p.align-center) {
		text-align: center;
		text-indent: 0;
	}
	.chapter :global(p.align-right) {
		text-align: right;
		text-indent: 0;
	}
	.chapter :global(p.align-justify) {
		text-align: justify;
	}
	.chapter :global(img) {
		max-width: 100%;
	}
	.scene-break {
		border: 0;
		text-align: center;
		margin: 2rem 0;
	}
	.scene-break::after {
		content: '* * *';
		color: #555;
	}
	.gate {
		text-align: center;
		padding-top: 6rem;
	}
	.continue {
		display: inline-block;
		margin: 1.5rem 0;
		padding: 0.6rem 1.2rem;
		border: 2px solid #1a4a8a;
		border-radius: 6px;
		font-weight: 700;
		text-decoration: none;
	}
</style>
