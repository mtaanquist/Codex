<script lang="ts">
	import type { EditorView } from '@codemirror/view';
	import Icon from './Icon.svelte';
	import {
		decreaseIndent,
		increaseIndent,
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

	// The overflow ("more") menu holds the view toggles, off the crowded main
	// row. Closes on an outside click.
	let viewMenuOpen = $state(false);
	let viewMenuWrap = $state<HTMLElement>();
	$effect(() => {
		if (!viewMenuOpen) return;
		const onClick = (event: MouseEvent) => {
			if (viewMenuWrap && !viewMenuWrap.contains(event.target as Node)) viewMenuOpen = false;
		};
		window.addEventListener('click', onClick, true);
		return () => window.removeEventListener('click', onClick, true);
	});
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
	<span class="md-sep"></span>
	<button
		class="md-tool"
		type="button"
		title="Decrease indent (Ctrl+[)"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(decreaseIndent)}
	>
		<Icon name="indent-decrease" size={16} />
	</button>
	<button
		class="md-tool"
		type="button"
		title="Increase indent (Ctrl+])"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(increaseIndent)}
	>
		<Icon name="indent-increase" size={16} />
	</button>
	{#if onToggleNonPrinting || onToggleCommandMarkers}
		<span class="md-sep"></span>
		<div class="md-overflow" bind:this={viewMenuWrap}>
			<button
				class="md-tool"
				class:is-active={viewMenuOpen}
				type="button"
				aria-label="View options"
				title="View options"
				aria-haspopup="menu"
				aria-expanded={viewMenuOpen}
				onmousedown={(event) => event.preventDefault()}
				onclick={() => (viewMenuOpen = !viewMenuOpen)}
			>
				<Icon name="more" size={16} />
			</button>
			{#if viewMenuOpen}
				<div class="md-menu" role="menu">
					{#if onToggleNonPrinting}
						<button
							class="md-menu-item"
							type="button"
							role="menuitemcheckbox"
							aria-checked={nonPrintingActive}
							onmousedown={(event) => event.preventDefault()}
							onclick={() => onToggleNonPrinting()}
						>
							<span class="md-menu-check">{nonPrintingActive ? '✓' : ''}</span>
							Show non-printing characters
						</button>
					{/if}
					{#if onToggleCommandMarkers}
						<button
							class="md-menu-item"
							type="button"
							role="menuitemcheckbox"
							aria-checked={commandMarkersActive}
							onmousedown={(event) => event.preventDefault()}
							onclick={() => onToggleCommandMarkers()}
						>
							<span class="md-menu-check">{commandMarkersActive ? '✓' : ''}</span>
							Show command markers (\center, \indent)
						</button>
					{/if}
				</div>
			{/if}
		</div>
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
	.md-overflow {
		position: relative;
		display: inline-flex;
	}
	.md-menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 20;
		min-width: 232px;
		padding: 6px;
		background: var(--bg-raised, var(--bg-inset));
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
	}
	.md-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		padding: 7px 8px;
		border: 0;
		border-radius: 7px;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.md-menu-item:hover {
		background: var(--bg-hover);
	}
	.md-menu-check {
		display: inline-block;
		width: 1em;
		flex: none;
		color: var(--accent);
		font-weight: 700;
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
