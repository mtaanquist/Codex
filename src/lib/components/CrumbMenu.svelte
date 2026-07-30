<script lang="ts">
	import Icon from './Icon.svelte';
	import { dismiss } from '$lib/dismiss';
	import type { CrumbMenuItem } from '$lib/chrome';

	// A place in the path. The name is the whole control: clicking it opens
	// everything that belongs to that place, starting with going there.
	let {
		label,
		current,
		groups
	}: {
		label: string;
		// True when you are already at the place itself.
		current: boolean;
		// Item groups, drawn with a rule between them.
		groups: CrumbMenuItem[][];
	} = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();

	function close() {
		open = false;
	}

	function onMenuKey(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const items = [...(menuEl?.querySelectorAll<HTMLAnchorElement>('.menu-item') ?? [])];
		const at = items.indexOf(document.activeElement as HTMLAnchorElement);
		event.preventDefault();
		if (event.key === 'ArrowDown') items[Math.min(at + 1, items.length - 1)]?.focus();
		else items[Math.max(at - 1, 0)]?.focus();
	}

	let menuEl = $state<HTMLDivElement>();
</script>

<span
	class="crumb-place"
	class:open
	use:dismiss={{ enabled: open, close, refocus: () => trigger?.focus() }}
>
	<button
		class="crumb crumb-menu"
		class:current
		type="button"
		bind:this={trigger}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-current={current ? 'page' : undefined}
		onclick={() => (open = !open)}
	>
		<span class="crumb-label">{label}</span>
		<Icon name="caret" />
	</button>
	<!-- eslint-disable svelte/no-navigation-without-resolve (chrome.ts resolves every href) -->
	<div class="popover crumb-pop" role="menu" tabindex="-1" bind:this={menuEl} onkeydown={onMenuKey}>
		{#each groups as items, group (group)}
			{#if group > 0}<div class="crumb-pop-sep"></div>{/if}
			{#each items as item (item.href)}
				<a
					class="menu-item"
					role="menuitem"
					href={item.href}
					aria-current={item.current ? 'page' : undefined}
					onclick={close}
				>
					{item.label}
				</a>
			{/each}
		{/each}
	</div>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</span>
