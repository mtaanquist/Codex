<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import AppBar from '$lib/components/AppBar.svelte';
	import ReaderFooter from '$lib/components/ReaderFooter.svelte';
	import { pageCrumb } from '$lib/chrome';
	import { formatNumber } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const shelfHref = $derived(resolve('/@[handle]', { handle: data.handle }));

	// Every chapter of the edition in one list, unfiled scenes last, so the
	// contents and the prose below it are built from the same thing.
	const chapters = $derived(
		data.gate
			? []
			: [
					...data.content.chapters.map((chapter, index) => ({
						id: `chapter-${index}`,
						title: chapter.title ?? `Chapter ${index + 1}`,
						scenes: chapter.scenes
					})),
					...(data.content.unfiled.length > 0
						? [
								{
									id: 'chapter-unfiled',
									title: 'Unfiled scenes',
									scenes: data.content.unfiled
								}
							]
						: [])
				]
	);

	function published(date: Date): string {
		return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
	}
</script>

<svelte:head>
	<title>{data.title} - by {data.author}</title>
	{#if data.gate || data.isAdult}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<div class="reader-shell">
	<AppBar
		shell="reader"
		crumbs={[{ kind: 'link', label: data.author, href: shelfHref }, pageCrumb(data.title)]}
		pathLabel="What you are reading"
		helpTopic="publishing"
		helpLabel="reading pages"
	/>

	<main class="reader-main">
		{#if data.gate}
			<div class="reader-col">
				<p class="reader-kicker">A story by <a href={shelfHref}>{data.author}</a></p>
				<h1 class="reader-title">{data.title}</h1>
				<p class="reader-byline">The author marked this story as adult content.</p>
				<p class="reader-byline">
					<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
					<a
						href={`${resolve('/@[handle]/[story=uuid]', { handle: data.handle, story: data.storyId })}?adult=ok`}
					>
						I am an adult; show the story
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</p>
				<p class="reader-byline"><a href={shelfHref}>Back to the shelf</a></p>
			</div>
		{:else}
			<div class="reader-col">
				<p class="reader-kicker">A story by <a href={shelfHref}>{data.author}</a></p>
				<h1 class="reader-title">{data.title}</h1>
				<p class="reader-byline">
					{chapters.length}
					{chapters.length === 1 ? 'chapter' : 'chapters'} - {formatNumber(data.words)} words - published
					{published(data.publishedAt)}{#if data.versionLabel}
						- {data.versionLabel}{/if}
				</p>

				{#if data.descriptionMd}
					<!-- Author markdown; renderMarkdown escapes raw HTML. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="reader-brief">{@html renderMarkdown(data.descriptionMd)}</div>
				{/if}

				{#if data.downloads.length > 0}
					<p class="reader-byline">
						Download:
						{#each data.downloads as artifact (artifact.id)}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (file download) -->
							<a href="/artifacts/{artifact.id}" download>
								{artifact.format === 'epub' ? 'EPUB' : 'PDF'}
							</a>
						{/each}
					</p>
				{/if}

				{#if chapters.length > 1}
					<nav class="reader-toc" aria-label="Chapters">
						<div class="reader-toc-label">Contents</div>
						{#each chapters as chapter, index (chapter.id)}
							<a href="#{chapter.id}">{index + 1}. {chapter.title}</a>
						{/each}
					</nav>
				{/if}

				{#each chapters as chapter, index (chapter.id)}
					<h2 class="reader-chapter" id={chapter.id}>{index + 1}. {chapter.title}</h2>
					<div class="reader-prose">
						{#each chapter.scenes as scene, si (si)}
							{#if si > 0}<p class="break">* * *</p>{/if}
							<!-- The shared renderer escapes raw HTML, so this is the
							     author's words only. -->
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							{@html renderMarkdown(scene.bodyMd)}
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</main>

	<ReaderFooter author={data.author} {shelfHref} />
</div>
