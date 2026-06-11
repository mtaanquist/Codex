<script lang="ts" module>
	// Right-click menu for sidebar rows: chapter tools or the scene actions.
	export type RowMenuTarget =
		| { kind: 'chapter'; id: string; index: number }
		| { kind: 'scene'; id: string };
	export type RowMenuState = { x: number; y: number; target: RowMenuTarget };
</script>

<script lang="ts">
	import type { SvelteSet } from 'svelte/reactivity';
	import Icon from './Icon.svelte';
	import { dismiss } from '$lib/dismiss';

	let {
		menu,
		chapterCount,
		assistantEnabled,
		selectedSceneId,
		mergeSelection,
		onClose,
		onRenameChapter,
		onReviewChapter,
		onReviewScene,
		onSuggestSplit,
		onDuplicateScene,
		onMergeSelected
	}: {
		menu: RowMenuState;
		chapterCount: number;
		assistantEnabled: boolean;
		// Sidebar actions reload the page; carrying the open scene keeps it open.
		selectedSceneId: string | null;
		// Shared with the outline, which highlights the picked rows.
		mergeSelection: SvelteSet<string>;
		onClose: (refocus?: boolean) => void;
		onRenameChapter: (chapterId: string) => void;
		onReviewChapter: (chapterId: string) => void;
		onReviewScene: (sceneId: string) => void;
		onSuggestSplit: (sceneId: string) => void;
		onDuplicateScene: (sceneId: string) => void;
		onMergeSelected: () => void;
	} = $props();

	const target = $derived(menu.target);

	let menuEl = $state<HTMLDivElement>();
	// The Assistant flyout inside the menu.
	let subOpen = $state(false);

	function onMenuKey(event: KeyboardEvent) {
		const items = menuEl ? [...menuEl.querySelectorAll<HTMLButtonElement>('.row-menu-item')] : [];
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose(true);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			items[Math.min(current + 1, items.length - 1)]?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			items[Math.max(current - 1, 0)]?.focus();
		}
	}

	// Move focus into the menu when it opens, so keyboard users can act on it.
	$effect(() => {
		if (menuEl) menuEl.querySelector<HTMLButtonElement>('.row-menu-item')?.focus();
	});

	function toggleMergeSelection(sceneId: string) {
		if (mergeSelection.has(sceneId)) mergeSelection.delete(sceneId);
		else mergeSelection.add(sceneId);
		onClose();
	}
</script>

{#snippet openSceneField()}
	{#if selectedSceneId}
		<input type="hidden" name="openSceneId" value={selectedSceneId} />
	{/if}
{/snippet}

<div
	class="row-menu"
	role="menu"
	tabindex="-1"
	bind:this={menuEl}
	use:dismiss={{ close: () => onClose() }}
	onkeydown={onMenuKey}
	style="left: {menu.x}px; top: {menu.y}px;"
>
	{#if target.kind === 'chapter'}
		<button
			class="row-menu-item"
			type="button"
			role="menuitem"
			onclick={() => onRenameChapter(target.id)}
		>
			<Icon name="pencil" size={13} /> Rename chapter
		</button>
		{#if assistantEnabled}
			<div
				class="row-sub"
				role="presentation"
				onmouseenter={() => (subOpen = true)}
				onmouseleave={() => (subOpen = false)}
			>
				<button
					class="row-menu-item row-sub-trigger"
					type="button"
					role="menuitem"
					aria-haspopup="menu"
					aria-expanded={subOpen}
					onclick={() => (subOpen = !subOpen)}
				>
					<span class="row-sub-label"><Icon name="sparkles" size={13} /> Assistant</span>
					<Icon name="chevron" size={12} />
				</button>
				{#if subOpen}
					<div class="row-submenu" role="menu">
						<button
							class="row-menu-item"
							type="button"
							role="menuitem"
							onclick={() => onReviewChapter(target.id)}
						>
							Review this chapter
						</button>
					</div>
				{/if}
			</div>
		{/if}
		<form method="POST" action="?/moveChapter">
			<input type="hidden" name="chapterId" value={target.id} />
			<input type="hidden" name="direction" value="up" />
			{@render openSceneField()}
			<button
				class="row-menu-item turn-up"
				type="submit"
				role="menuitem"
				disabled={target.index === 0}
			>
				<Icon name="chevron" size={13} /> Move up
			</button>
		</form>
		<form method="POST" action="?/moveChapter">
			<input type="hidden" name="chapterId" value={target.id} />
			<input type="hidden" name="direction" value="down" />
			{@render openSceneField()}
			<button
				class="row-menu-item turn-down"
				type="submit"
				role="menuitem"
				disabled={target.index === chapterCount - 1}
			>
				<Icon name="chevron" size={13} /> Move down
			</button>
		</form>
		<form
			method="POST"
			action="?/deleteChapter"
			onsubmit={(e) => {
				if (!confirm('Delete this chapter? Its scenes move to Unfiled scenes.')) e.preventDefault();
			}}
		>
			<input type="hidden" name="chapterId" value={target.id} />
			{@render openSceneField()}
			<button class="row-menu-item danger" type="submit" role="menuitem">
				<Icon name="trash" size={13} /> Delete chapter
			</button>
		</form>
	{:else}
		{@const pickedForMerge = mergeSelection.has(target.id)}
		<button
			class="row-menu-item"
			type="button"
			role="menuitem"
			onclick={() => toggleMergeSelection(target.id)}
		>
			<Icon name="plus" size={13} />
			{pickedForMerge ? 'Unselect for merging' : 'Select for merging'}
		</button>
		<button
			class="row-menu-item"
			type="button"
			role="menuitem"
			onclick={() => onDuplicateScene(target.id)}
		>
			<Icon name="copy" size={13} /> Duplicate scene
		</button>
		{#if assistantEnabled}
			<div
				class="row-sub"
				role="presentation"
				onmouseenter={() => (subOpen = true)}
				onmouseleave={() => (subOpen = false)}
			>
				<button
					class="row-menu-item row-sub-trigger"
					type="button"
					role="menuitem"
					aria-haspopup="menu"
					aria-expanded={subOpen}
					onclick={() => (subOpen = !subOpen)}
				>
					<span class="row-sub-label"><Icon name="sparkles" size={13} /> Assistant</span>
					<Icon name="chevron" size={12} />
				</button>
				{#if subOpen}
					<div class="row-submenu" role="menu">
						<button
							class="row-menu-item"
							type="button"
							role="menuitem"
							onclick={() => onReviewScene(target.id)}
						>
							Review this scene
						</button>
						<button
							class="row-menu-item"
							type="button"
							role="menuitem"
							onclick={() => onSuggestSplit(target.id)}
						>
							Suggest where to split
						</button>
					</div>
				{/if}
			</div>
		{/if}
		{#if pickedForMerge && mergeSelection.size >= 2}
			<button class="row-menu-item" type="button" role="menuitem" onclick={onMergeSelected}>
				<Icon name="chapter" size={13} /> Merge {mergeSelection.size} scenes
			</button>
		{/if}
		{#if mergeSelection.size > 0}
			<button
				class="row-menu-item"
				type="button"
				role="menuitem"
				onclick={() => {
					mergeSelection.clear();
					onClose();
				}}
			>
				Clear merge selection
			</button>
		{/if}
		<form method="POST" action="?/deleteScene">
			<input type="hidden" name="sceneId" value={target.id} />
			{@render openSceneField()}
			<button class="row-menu-item danger" type="submit" role="menuitem">
				<Icon name="trash" size={13} /> Delete scene
			</button>
		</form>
	{/if}
</div>

<style>
	.row-menu {
		position: fixed;
		z-index: 60;
		min-width: 170px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
	}
	.row-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		padding: 6px 7px;
		border-radius: 5px;
		/* Native context menus keep the arrow cursor; match them. */
		cursor: default;
	}
	.row-menu-item:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	/* The Assistant flyout, the editor selection menu's submenu pattern. */
	.row-sub {
		position: relative;
	}
	.row-sub-trigger {
		justify-content: space-between;
	}
	.row-sub-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.row-submenu {
		position: absolute;
		left: calc(100% - 2px);
		top: -7px;
		min-width: 180px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
		z-index: 61;
	}
	.row-menu-item:disabled {
		color: var(--text-faint);
	}
	.row-menu-item.danger:hover:not(:disabled) {
		color: var(--danger, #c0564f);
	}
	.row-menu-item.turn-up :global(svg) {
		transform: rotate(-90deg);
	}
	.row-menu-item.turn-down :global(svg) {
		transform: rotate(90deg);
	}
</style>
