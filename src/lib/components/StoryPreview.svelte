<script lang="ts">
	import Icon from './Icon.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { contentWidthCss, fontFamilyCss, lineHeightCss, type PageSetup } from '$lib/page-setup';
	import { focusMode } from '$lib/focus-mode.svelte';

	let {
		storyTitle,
		chapters,
		storyDoc,
		pageSetup,
		editStoryHref,
		toggleHref
	}: {
		storyTitle: string;
		chapters: { id: string; title: string | null }[];
		storyDoc: { id: string; chapterId: string | null; bodyMd: string }[];
		pageSetup: PageSetup | null;
		editStoryHref: string;
		toggleHref: string;
	} = $props();

	function docScenes(chapterId: string | null) {
		return storyDoc.filter((scene) => scene.chapterId === chapterId);
	}

	// Preview honours the story's paragraph style and scene-break text, like
	// the export. The break text is escaped for the CSS content property.
	const previewSpaced = $derived(pageSetup?.paragraphStyle === 'spaced');
	const previewSceneBreak = $derived(
		(pageSetup?.sceneBreak ?? '* * *').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
	);
	// The preview shows the prose at the page's text-column width, print font,
	// size, and line spacing, so line length and spacing match the export. (The
	// alternating spine gutter only shows in the paginated Print view.)
	const previewStyle = $derived.by(() => {
		let css = `--scene-break: "${previewSceneBreak}";`;
		const setup = pageSetup;
		if (setup) {
			css +=
				` max-width: ${contentWidthCss(setup)};` +
				` font-family: ${fontFamilyCss(setup)};` +
				` font-size: ${setup.fontSize}pt; line-height: ${lineHeightCss(setup)};` +
				` --page-align: ${setup.textAlign};`;
		}
		return css;
	});
</script>

<!-- Read-only render of the whole story through the export's markdown
     renderer, so the writer sees what an export looks like: no underlines,
     no markers, alignment and scene breaks applied. -->
<div class="md-editor">
	<div class="md-toolbar">
		<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
		<a class="md-tool md-preview-edit" href={editStoryHref} title="Back to editing">
			<Icon name="pencil" size={15} />
			<span class="md-tool-label">Edit</span>
		</a>
		<div class="md-right">
			<span class="md-hint">Preview</span>
			<a class="md-tool" href={toggleHref} title="Back to the scene editor">
				<Icon name="scene" size={16} />
			</a>
			<button
				class="md-tool"
				type="button"
				title="Focus mode"
				onclick={() => (focusMode.on = true)}
			>
				<Icon name="expand" size={16} />
			</button>
		</div>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</div>
	<div class="editor-scroll">
		<div class="editor story-preview" class:spaced={previewSpaced} style={previewStyle}>
			<h1 class="doc-title">{storyTitle}</h1>
			{#if storyDoc.length === 0}
				<div class="empty">
					<p>Nothing written yet. Switch back to the editor to add scenes.</p>
				</div>
			{/if}
			{#each chapters as chapter, index (chapter.id)}
				{@const list = docScenes(chapter.id)}
				{#if list.length > 0}
					<section class="prev-chapter">
						<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
						{#each list as scene, si (scene.id)}
							{#if si > 0}<hr class="scene-break" />{/if}
							<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
							{@html renderMarkdown(scene.bodyMd)}
						{/each}
					</section>
				{/if}
			{/each}
			{#if docScenes(null).length > 0}
				<section class="prev-chapter">
					<h2>Unfiled scenes</h2>
					{#each docScenes(null) as scene, si (scene.id)}
						{#if si > 0}<hr class="scene-break" />{/if}
						<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
						{@html renderMarkdown(scene.bodyMd)}
					{/each}
				</section>
			{/if}
		</div>
	</div>
</div>

<style>
	.md-preview-edit {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		text-decoration: none;
		color: var(--text-muted);
	}
	.md-preview-edit:hover {
		color: var(--text);
	}
	.md-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.md-right .md-hint {
		margin-left: 0;
	}
	.story-preview {
		font-family: var(--font-content);
		line-height: 1.7;
	}
	.prev-chapter h2 {
		font-family: var(--font-content);
		font-size: 23px;
		font-weight: 600;
		text-align: center;
		margin: 40px 0 20px;
	}
	.story-preview :global(p) {
		margin: 0 0 0.2rem;
		text-indent: 1.5em;
		text-align: var(--page-align, left);
	}
	.story-preview.spaced :global(p) {
		margin: 0 0 0.85em;
		text-indent: 0;
	}
	/* Centered and right-aligned paragraphs drop the indent, as in the export. */
	.story-preview :global(p.align-center) {
		text-align: center;
		text-indent: 0;
	}
	.story-preview :global(p.align-right) {
		text-align: right;
		text-indent: 0;
	}
	.story-preview :global(p.align-justify) {
		text-align: justify;
	}
	.story-preview :global(img) {
		max-width: 100%;
	}
	.scene-break {
		border: 0;
		text-align: center;
		margin: 2rem 0;
	}
	.scene-break::after {
		content: var(--scene-break, '* * *');
		color: var(--text-faint);
	}
	.story-preview :global(.page-break) {
		border-top: 1px dashed var(--border);
		margin: 2.5rem 0;
	}
</style>
