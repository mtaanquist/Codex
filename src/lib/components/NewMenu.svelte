<script lang="ts">
	import Icon from './Icon.svelte';
	import { dismiss } from '$lib/dismiss';

	// One creation control, used by every collection: a button, a popover of
	// rows, then a rule and the import row, then one line of help. Import is a
	// way of making, not a link off to one side, so it lives in here too.
	export type NewMenuItem = {
		label: string;
		// A button that starts an inline form here, or a link to another page.
		onSelect?: () => void;
		href?: string;
	};

	let {
		label,
		items,
		importItem,
		note,
		variant = 'secondary',
		size = 'sm',
		align = 'end'
	}: {
		// The button's own label ("New", "New story").
		label: string;
		items: NewMenuItem[];
		// The import row, under the rule. Omitted where nothing can be imported.
		importItem?: NewMenuItem;
		// One line telling a first-time user what the choices mean.
		note: string;
		variant?: 'primary' | 'secondary';
		size?: 'sm' | 'md';
		// 'start' opens the menu from the button's left edge, for a button that
		// sits on the left of its row.
		align?: 'start' | 'end';
	} = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();

	function close() {
		open = false;
	}

	function choose(item: NewMenuItem) {
		close();
		item.onSelect?.();
	}

	let menuEl = $state<HTMLDivElement>();

	function onMenuKey(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const rows = [...(menuEl?.querySelectorAll<HTMLElement>('.menu-item') ?? [])];
		const at = rows.indexOf(document.activeElement as HTMLElement);
		event.preventDefault();
		if (event.key === 'ArrowDown') rows[Math.min(at + 1, rows.length - 1)]?.focus();
		else rows[Math.max(at - 1, 0)]?.focus();
	}
</script>

<span
	class="menu-host"
	class:open
	class:start={align === 'start'}
	use:dismiss={{ enabled: open, close, refocus: () => trigger?.focus() }}
>
	<button
		class="btn btn-{variant}"
		class:btn-sm={size === 'sm'}
		type="button"
		bind:this={trigger}
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{label}
		<span class="new-caret"><Icon name="caret" /></span>
	</button>
	<!-- eslint-disable svelte/no-navigation-without-resolve (callers resolve every href) -->
	<div class="popover" role="menu" tabindex="-1" bind:this={menuEl} onkeydown={onMenuKey}>
		{#each items as item (item.label)}
			{#if item.href}
				<a class="menu-item" role="menuitem" href={item.href} onclick={close}>{item.label}</a>
			{:else}
				<button class="menu-item" role="menuitem" type="button" onclick={() => choose(item)}>
					{item.label}
				</button>
			{/if}
		{/each}
		{#if importItem}
			<div class="menu-sep"></div>
			{#if importItem.href}
				<a class="menu-item" role="menuitem" href={importItem.href} onclick={close}>
					{importItem.label}
				</a>
			{:else}
				<button class="menu-item" role="menuitem" type="button" onclick={() => choose(importItem)}>
					{importItem.label}
				</button>
			{/if}
		{/if}
		<p class="menu-note">{note}</p>
	</div>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</span>

<style>
	/* The caret is part of the button's label row, so it takes the button's
	   colour and sits on the baseline with the text. */
	.new-caret {
		display: inline-flex;
	}
</style>
