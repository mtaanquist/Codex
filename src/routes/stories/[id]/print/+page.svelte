<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import { fontFamilyCss, lineHeightCss, pageRuleCss } from '$lib/page-setup';
	import ViewMenu, { type ViewItem } from '$lib/components/ViewMenu.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function chapterScenes(chapterId: string | null) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}

	// The View dropdown back to the other views; this page is "Print".
	const storyHref = $derived(resolve('/stories/[id]', { id: data.story.slug }));
	const viewMenu = $derived<ViewItem[]>([
		{ id: 'edit', label: 'Edit', icon: 'pencil', href: storyHref },
		{ id: 'preview', label: 'Preview', icon: 'book', href: `${storyHref}?view=preview` },
		{ id: 'print', label: 'Print', icon: 'print', current: true }
	]);

	// The page setup parameterizes the stylesheet: typography and scene
	// breaks via CSS variables on the wrapper, the page geometry via a
	// dynamic @page rule. All values come from fixed option tables except
	// the scene-break text, which is escaped for the content property.
	const setup = $derived(data.pageSetup);
	const sceneBreakText = $derived(setup.sceneBreak.replaceAll('\\', '\\\\').replaceAll('"', '\\"'));
	const pageVars = $derived(
		`font-family: ${fontFamilyCss(setup)}; font-size: ${setup.fontSize}pt; ` +
			`line-height: ${lineHeightCss(setup)}; --page-align: ${setup.textAlign}; ` +
			`--scene-break: "${sceneBreakText}";`
	);
	const pageRule = $derived(pageRuleCss(setup));
</script>

<svelte:head>
	<title>{data.story.title} - Print - Codex</title>
	<!-- eslint-disable-next-line svelte/no-at-html-tags (built from fixed option tables, no user text) -->
	{@html `<style>${pageRule}</style>`}
</svelte:head>

<div class="print-topbar no-print">
	<span class="print-topbar-title">Print preview</span>
	<span class="print-topbar-hint">Choose "Save as PDF" in the print dialog to export.</span>
	<div class="print-topbar-right">
		<ViewMenu items={viewMenu} />
		<button class="btn btn-primary" type="button" onclick={() => window.print()}>Print</button>
	</div>
</div>

<div class="print-page" class:spaced={setup.paragraphStyle === 'spaced'} style={pageVars}>
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
	.print-topbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 10px 20px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
	}
	.print-topbar-title {
		font-weight: 600;
		color: var(--text);
	}
	.print-topbar-hint {
		color: var(--text-muted);
		font-size: 13px;
	}
	.print-topbar-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.print-page {
		max-width: 42rem;
		margin: 0 auto;
		padding: 2rem 1rem;
		color: #000;
		background: #fff;
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
		content: var(--scene-break, '* * *');
		color: #444;
	}
	.chapter :global(p) {
		margin: 0 0 0.2rem;
		text-indent: 1.5em;
		text-align: var(--page-align, left);
	}
	.spaced .chapter :global(p) {
		margin: 0 0 0.8em;
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
	:global(.page-break) {
		page-break-after: always;
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
