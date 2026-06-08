<script lang="ts">
	import type { EditorView } from '@codemirror/view';
	import Icon from './Icon.svelte';
	import {
		setAlignment,
		setHeading,
		toggleBold,
		toggleBulletList,
		toggleItalic,
		toggleQuote
	} from '$lib/editor-format';
	import { ALIGNMENTS } from '$lib/alignment';

	// The formatting bar above a prose editor: headings, bold, italic,
	// quote, list. Buttons act on the editor and hand focus straight back.
	let {
		view,
		modeLabel,
		onSplitScene,
		previewHref,
		storyView,
		nonPrintingActive,
		onToggleNonPrinting,
		commandMarkersActive,
		onToggleCommandMarkers,
		onEnterFocus
	}: {
		view: () => EditorView | undefined;
		modeLabel?: string;
		// When set, a split button breaks the scene at the cursor.
		onSplitScene?: () => void;
		// When set, a Preview button at the end of the bar opens the read-only
		// export preview (the whole-story view only).
		previewHref?: string;
		// The scene <-> whole-story toggle, shown at the end of the bar.
		storyView?: { active: boolean; toggleHref: string };
		// The view toggles: show non-printing characters, and hide the command
		// markers (\center and friends). Each button appears only when its
		// toggle callback is set; active marks the toggle as on.
		nonPrintingActive?: boolean;
		onToggleNonPrinting?: () => void;
		commandMarkersActive?: boolean;
		onToggleCommandMarkers?: () => void;
		// Enters distraction-free writing.
		onEnterFocus?: () => void;
	} = $props();

	function run(command: (view: EditorView) => boolean) {
		const editor = view();
		if (!editor) return;
		command(editor);
		editor.focus();
	}
</script>

<div class="md-toolbar">
	<button
		class="md-tool"
		type="button"
		title="Heading 1"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(setHeading(1))}
	>
		<span class="md-tool-label">H1</span>
	</button>
	<button
		class="md-tool"
		type="button"
		title="Heading 2"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(setHeading(2))}
	>
		<span class="md-tool-label">H2</span>
	</button>
	<button
		class="md-tool"
		type="button"
		title="Heading 3"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(setHeading(3))}
	>
		<span class="md-tool-label">H3</span>
	</button>
	<span class="md-sep"></span>
	<button
		class="md-tool"
		type="button"
		title="Bold (Ctrl+B)"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleBold)}
	>
		<Icon name="bold" size={16} />
	</button>
	<button
		class="md-tool"
		type="button"
		title="Italic (Ctrl+I)"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleItalic)}
	>
		<Icon name="italic" size={16} />
	</button>
	<span class="md-sep"></span>
	<button
		class="md-tool"
		type="button"
		title="Quote"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleQuote)}
	>
		<Icon name="quote" size={16} />
	</button>
	<button
		class="md-tool"
		type="button"
		title="Bullet list"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleBulletList)}
	>
		<Icon name="list" size={16} />
	</button>
	<span class="md-sep"></span>
	{#each ALIGNMENTS as align (align)}
		<button
			class="md-tool"
			type="button"
			title="Align {align}"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => run(setAlignment(align))}
		>
			<Icon name="align-{align}" size={16} />
		</button>
	{/each}
	{#if onToggleNonPrinting || onToggleCommandMarkers}
		<span class="md-sep"></span>
		{#if onToggleNonPrinting}
			<button
				class="md-tool"
				class:is-active={nonPrintingActive}
				type="button"
				aria-label="Non-printing characters"
				title={nonPrintingActive ? 'Hide non-printing characters' : 'Show non-printing characters'}
				aria-pressed={nonPrintingActive}
				onmousedown={(event) => event.preventDefault()}
				onclick={() => onToggleNonPrinting()}
			>
				<Icon name="pilcrow" size={16} />
			</button>
		{/if}
		{#if onToggleCommandMarkers}
			<button
				class="md-tool"
				class:is-active={commandMarkersActive}
				type="button"
				aria-label="Command markers"
				title={commandMarkersActive
					? 'Show command markers (\\center, \\right, \\justify)'
					: 'Hide command markers (\\center, \\right, \\justify)'}
				aria-pressed={commandMarkersActive}
				onmousedown={(event) => event.preventDefault()}
				onclick={() => onToggleCommandMarkers()}
			>
				<Icon name="eye" size={16} />
			</button>
		{/if}
	{/if}
	{#if onSplitScene}
		<span class="md-sep"></span>
		<button
			class="md-tool"
			type="button"
			title="Split scene at cursor"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => onSplitScene()}
		>
			<Icon name="split" size={16} />
		</button>
	{/if}
	<div class="md-right">
		{#if modeLabel}
			<span class="md-hint">{modeLabel}</span>
		{/if}
		{#if previewHref}
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a class="md-tool md-preview" href={previewHref} title="See how this will look when exported">
				<Icon name="book" size={15} />
				<span class="md-tool-label">Preview</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
		{#if storyView}
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a
				class="md-tool"
				href={storyView.toggleHref}
				title={storyView.active ? 'Back to the scene editor' : 'Read the whole story'}
			>
				<Icon name={storyView.active ? 'scene' : 'chapter'} size={16} />
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
		{#if onEnterFocus}
			<button class="md-tool" type="button" title="Focus mode" onclick={() => onEnterFocus()}>
				<Icon name="expand" size={16} />
			</button>
		{/if}
	</div>
</div>

<style>
	.md-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.md-right .md-hint {
		margin-left: 0;
	}
	.md-preview {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		text-decoration: none;
		color: var(--text-muted);
	}
	.md-preview:hover {
		color: var(--text);
	}
</style>
