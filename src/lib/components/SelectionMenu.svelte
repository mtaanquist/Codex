<script lang="ts">
	import { onMount } from 'svelte';
	import type { EditorView } from '@codemirror/view';
	import { dismiss } from '$lib/dismiss';
	import { modLabel } from '$lib/keys';
	import { toggleBold, toggleBulletList, toggleItalic, toggleQuote } from '$lib/editor-format';
	import Icon from './Icon.svelte';

	// SSR cannot know the platform, so the modifier label settles after mount.
	let mod = $state<'Cmd' | 'Ctrl'>('Ctrl');
	onMount(() => (mod = modLabel()));

	// The right-click selection menu: quick formatting plus create-from-selection
	// and an Assistant hand-off. The parent opens it from the pane's context menu
	// (computing the position and selected text) and renders it only while open,
	// so this resets its submenu and busy state on each open.
	let {
		menu,
		getView,
		onCreateEntity,
		onAskAssistant,
		loreCategories = [],
		onClose
	}: {
		menu: { x: number; y: number; name: string; raw: string };
		getView: () => EditorView | undefined;
		onCreateEntity?: (
			type: 'character' | 'place' | 'lore_entry',
			name: string,
			categoryId?: string
		) => Promise<string | null>;
		onAskAssistant?: (text: string) => void;
		loreCategories?: { id: string; name: string }[];
		onClose: () => void;
	} = $props();

	let busy = $state(false);
	let error = $state('');
	let loreSubOpen = $state(false);
	let assistantSubOpen = $state(false);

	function askAssistant() {
		if (!onAskAssistant) return;
		onAskAssistant(menu.raw);
		onClose();
	}

	function runFormat(command: (view: EditorView) => boolean) {
		const view = getView();
		if (view) command(view);
		onClose();
		view?.focus();
	}

	async function createFromSelection(
		type: 'character' | 'place' | 'lore_entry',
		categoryId?: string
	) {
		if (!onCreateEntity || busy) return;
		busy = true;
		error = '';
		try {
			const failure = await onCreateEntity(type, menu.name, categoryId);
			if (failure) {
				error = failure;
				busy = false;
			} else {
				onClose();
			}
		} catch {
			error = 'Could not create it. Try again.';
			busy = false;
		}
	}
</script>

<div
	class="sel-menu"
	role="menu"
	use:dismiss={{ close: onClose, refocus: () => getView()?.focus() }}
	style="left: {menu.x}px; top: {menu.y}px;"
>
	<div class="sel-menu-formats">
		<button
			class="sel-format"
			type="button"
			role="menuitem"
			title={`Bold (${mod}+B)`}
			onclick={() => runFormat(toggleBold)}
		>
			<Icon name="bold" size={15} />
		</button>
		<button
			class="sel-format"
			type="button"
			role="menuitem"
			title={`Italic (${mod}+I)`}
			onclick={() => runFormat(toggleItalic)}
		>
			<Icon name="italic" size={15} />
		</button>
		<button
			class="sel-format"
			type="button"
			role="menuitem"
			title="Quote"
			onclick={() => runFormat(toggleQuote)}
		>
			<Icon name="quote" size={15} />
		</button>
		<button
			class="sel-format"
			type="button"
			role="menuitem"
			title="Bullet list"
			onclick={() => runFormat(toggleBulletList)}
		>
			<Icon name="list" size={15} />
		</button>
	</div>
	{#if onCreateEntity || onAskAssistant}
		<div class="sel-menu-label">
			"{menu.name.length > 32 ? `${menu.name.slice(0, 32)}...` : menu.name}"
		</div>
	{/if}
	{#if onAskAssistant}
		<div
			class="sel-sub"
			role="presentation"
			onmouseenter={() => (assistantSubOpen = true)}
			onmouseleave={() => (assistantSubOpen = false)}
		>
			<button
				class="sel-create sel-sub-trigger"
				type="button"
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={assistantSubOpen}
				onclick={() => (assistantSubOpen = !assistantSubOpen)}
			>
				<span class="sel-sub-label"><Icon name="sparkles" size={13} /> Assistant</span>
				<Icon name="chevron" size={12} />
			</button>
			{#if assistantSubOpen}
				<div class="sel-submenu" role="menu">
					<button class="sel-create" type="button" role="menuitem" onclick={askAssistant}>
						Ask the Assistant about this
					</button>
				</div>
			{/if}
		</div>
	{/if}
	{#if onCreateEntity}
		<button
			class="sel-create"
			type="button"
			role="menuitem"
			disabled={busy}
			onclick={() => createFromSelection('character')}
		>
			New character
		</button>
		<button
			class="sel-create"
			type="button"
			role="menuitem"
			disabled={busy}
			onclick={() => createFromSelection('place')}
		>
			New place
		</button>
		{#if loreCategories.length > 1}
			<!-- More than one category: the lore item opens a flyout to pick
			     which one the new entry files under. -->
			<div
				class="sel-sub"
				role="presentation"
				onmouseenter={() => (loreSubOpen = true)}
				onmouseleave={() => (loreSubOpen = false)}
			>
				<button
					class="sel-create sel-sub-trigger"
					type="button"
					role="menuitem"
					aria-haspopup="menu"
					aria-expanded={loreSubOpen}
					disabled={busy}
					onclick={() => (loreSubOpen = !loreSubOpen)}
				>
					New lore entry
					<Icon name="chevron" size={12} />
				</button>
				{#if loreSubOpen}
					<div class="sel-submenu" role="menu">
						{#each loreCategories as category (category.id)}
							<button
								class="sel-create"
								type="button"
								role="menuitem"
								disabled={busy}
								onclick={() => createFromSelection('lore_entry', category.id)}
							>
								{category.name}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{:else}
			<button
				class="sel-create"
				type="button"
				role="menuitem"
				disabled={busy}
				onclick={() => createFromSelection('lore_entry')}
			>
				New lore entry
			</button>
		{/if}
		{#if error}
			<p class="sel-menu-error" role="alert">{error}</p>
		{/if}
	{/if}
</div>

<style>
	/* The right-click selection menu. */
	.sel-menu {
		position: fixed;
		z-index: 60;
		min-width: 190px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
	}
	.sel-menu-formats {
		display: flex;
		gap: 2px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--border);
		margin-bottom: 4px;
	}
	.sel-format {
		border: 0;
		background: none;
		color: var(--text-muted);
		border-radius: 5px;
		padding: 5px 7px;
		/* Native context menus keep the arrow cursor; match them. */
		cursor: default;
		display: inline-flex;
	}
	.sel-format:hover {
		background: var(--accent-soft);
		color: var(--text);
	}
	.sel-menu-label {
		font-family: var(--font-ui);
		font-size: 10.5px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		padding: 4px 7px 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 220px;
	}
	.sel-create {
		display: block;
		width: 100%;
		text-align: left;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		padding: 6px 7px;
		border-radius: 5px;
		cursor: default;
	}
	.sel-create:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	.sel-create:disabled {
		color: var(--text-faint);
	}
	.sel-menu-error {
		font-family: var(--font-ui);
		font-size: 12px;
		color: var(--danger, #c0564f);
		margin: 2px 7px 4px;
	}
	/* The lore item's category flyout. */
	.sel-sub {
		position: relative;
	}
	.sel-sub-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.sel-sub-label {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}
	.sel-submenu {
		position: absolute;
		left: calc(100% - 2px);
		top: -7px;
		min-width: 150px;
		max-height: 260px;
		overflow-y: auto;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
		z-index: 61;
	}
</style>
