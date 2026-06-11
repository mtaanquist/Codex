<script lang="ts" module>
	import type { IconName } from './Icon.svelte';

	// One entry in the View menu. Exactly one of href (a navigation) or onSelect
	// (an action, like entering focus mode) is set. `current` marks the mode in
	// effect; it shows on the trigger and is ticked in the menu.
	export type ViewItem = {
		id: string;
		label: string;
		icon: IconName;
		href?: string;
		onSelect?: () => void;
		current?: boolean;
	};
</script>

<script lang="ts">
	import Icon from './Icon.svelte';
	import { dismiss } from '$lib/dismiss';

	let { items }: { items: ViewItem[] } = $props();
	let open = $state(false);
	const active = $derived(items.find((item) => item.current));
</script>

<div class="md-view" use:dismiss={{ enabled: open, close: () => (open = false) }}>
	<button
		class="md-tool md-view-trigger"
		class:is-active={open}
		type="button"
		title="Switch view"
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<Icon name={active?.icon ?? 'book'} size={15} />
		<span class="md-tool-label">{active?.label ?? 'View'}</span>
		<Icon name="chevron" size={11} />
	</button>
	{#if open}
		<!-- eslint-disable svelte/no-navigation-without-resolve (the caller resolves each href) -->
		<div class="md-view-menu" role="menu">
			{#each items as item (item.id)}
				{#if item.href}
					<a
						class="md-view-item"
						class:is-current={item.current}
						role="menuitem"
						href={item.href}
						onclick={() => (open = false)}
					>
						<Icon name={item.icon} size={15} />
						{item.label}
					</a>
				{:else}
					<button
						class="md-view-item"
						class:is-current={item.current}
						type="button"
						role="menuitem"
						onclick={() => {
							item.onSelect?.();
							open = false;
						}}
					>
						<Icon name={item.icon} size={15} />
						{item.label}
					</button>
				{/if}
			{/each}
		</div>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}
</div>

<style>
	.md-view {
		position: relative;
		display: inline-flex;
	}
	.md-view-trigger {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--text-muted);
	}
	.md-view-trigger:hover,
	.md-view-trigger.is-active {
		color: var(--text);
	}
	.md-view-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 20;
		min-width: 168px;
		padding: 6px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
	}
	.md-view-item {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		text-align: left;
		padding: 7px 9px;
		border: 0;
		border-radius: 7px;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		text-decoration: none;
		cursor: pointer;
	}
	.md-view-item:hover {
		background: var(--bg-hover);
	}
	.md-view-item.is-current {
		color: var(--accent);
	}
</style>
