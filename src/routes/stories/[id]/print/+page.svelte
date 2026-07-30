<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import { fontFamilyCss, lineHeightCss, pageRuleCss } from '$lib/page-setup';
	import AppBar from '$lib/components/AppBar.svelte';
	import { storyPath } from '$lib/chrome';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function chapterScenes(chapterId: string | null) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}

	const pageSetupHref = $derived(
		resolve('/stories/[id]/settings/[[section]]', {
			id: data.story.slug,
			section: 'pagesetup'
		})
	);

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

<div class="page-shell">
	<div class="no-print">
		<AppBar
			crumbs={storyPath(
				data.universe,
				{ ...data.story, reading: data.reading },
				{
					storyAt: 'print',
					page: 'Print preview'
				}
			)}
			helpTopic="publishing"
			helpLabel="printing and exporting"
		/>
	</div>

	<div class="page-body">
		<div class="print-head page-header no-print">
			<div>
				<h1 class="page-title">Print preview</h1>
				<p class="page-subtitle">
					This is how the story comes out on paper. Choose "Save as PDF" in the print dialog if you
					want a file instead.
				</p>
			</div>
			<div class="page-actions">
				<a class="btn btn-secondary" href={pageSetupHref}>Page setup</a>
				<button class="btn btn-primary" type="button" onclick={() => window.print()}>Print</button>
			</div>
		</div>

		<!-- The paper is the artefact being previewed, not chrome: it wears the
		     light theme so its white and its ink are still tokens. -->
		<div
			class="print-page"
			class:spaced={setup.paragraphStyle === 'spaced'}
			style={pageVars}
			data-theme="light"
		>
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
	</div>
</div>

<style>
	.print-head {
		max-width: 42rem;
		margin: 0 auto var(--space-5);
		padding: var(--space-6) 1rem 0;
	}
	/* The sheet carries data-theme="light", so these are its own tokens. */
	.print-page {
		max-width: 42rem;
		margin: 0 auto;
		padding: 2rem 1rem;
		color: var(--text);
		background: var(--bg-canvas);
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
		color: var(--text-muted);
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
