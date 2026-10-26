<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import { dismiss } from '$lib/dismiss';
	import { menu } from '$lib/menu';
	import { THEME_CHOICES, deviceChoice, setTheme } from '$lib/theme';
	import type { ConcreteTheme, Theme } from '$lib/appearance';

	// The theme picker: Light, Warm, Dark or System, with the current choice
	// checked. 'items' renders the four choices as radio items for a menu that
	// already exists (the account menu); 'button' is a bar tool of its own, an
	// icon button with a small menu, for bars with no account menu (guest,
	// reader, public). A signed-in viewer's choice is saved to their account; a
	// signed-out one keeps it on this device.
	let { variant = 'button' }: { variant?: 'items' | 'button' } = $props();

	type Saved = {
		theme: Theme;
		accent: string;
		systemLightTheme: ConcreteTheme;
		systemDarkTheme: ConcreteTheme;
	};
	const saved = $derived((page.data.appearance ?? null) as Saved | null);

	let deviceTheme = $state<Theme>(browser ? deviceChoice() : 'system');
	// The choice just made, shown until the account save comes back.
	let picked = $state<Theme | null>(null);
	const current = $derived(picked ?? (saved ? saved.theme : deviceTheme));

	// The palette on screen, for the bar button's icon.
	let shown = $state<string>(browser ? (document.documentElement.dataset.theme ?? 'dark') : 'dark');

	async function choose(choice: Theme) {
		picked = choice;
		if (!saved) deviceTheme = choice;
		const done = setTheme(choice, saved);
		shown = document.documentElement.dataset.theme ?? shown;
		await done;
		picked = null;
	}

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	const close = () => (open = false);
	const currentLabel = $derived(THEME_CHOICES.find((c) => c.id === current)?.label ?? 'System');
</script>

{#if variant === 'items'}
	<div class="seg theme-seg" role="group" aria-label="Theme">
		{#each THEME_CHOICES as choice (choice.id)}
			<button
				class="seg-btn"
				class:active={current === choice.id}
				type="button"
				role="menuitemradio"
				aria-checked={current === choice.id}
				onclick={() => choose(choice.id)}
			>
				{choice.label}
			</button>
		{/each}
	</div>
{:else}
	<div class="theme-pick" use:dismiss={{ enabled: open, close, refocus: () => trigger?.focus() }}>
		<button
			bind:this={trigger}
			class="icon-btn"
			type="button"
			title="Theme: {currentLabel}"
			aria-label="Theme: {currentLabel}"
			aria-haspopup="menu"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			<Icon name={shown === 'light' ? 'sun' : shown === 'warm' ? 'sunset' : 'moon'} />
		</button>
		{#if open}
			<div
				class="popover theme-pop"
				role="menu"
				aria-label="Theme"
				use:menu={{ close, refocus: () => trigger?.focus() }}
			>
				{#each THEME_CHOICES as choice (choice.id)}
					<button
						class="menu-item"
						type="button"
						role="menuitemradio"
						aria-checked={current === choice.id}
						onclick={() => {
							void choose(choice.id);
							close();
							trigger?.focus();
						}}
					>
						<span class="theme-check">
							{#if current === choice.id}<Icon name="check" size={14} />{/if}
						</span>
						{choice.label}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.theme-seg {
		display: flex;
		margin: 2px 4px;
	}
	.theme-seg .seg-btn {
		flex: 1;
		padding-left: 6px;
		padding-right: 6px;
	}
	/* Skin from the shared .popover / .menu-item (menus.css); only the
	   positioning and the check column stay here. */
	.theme-pick {
		position: relative;
		display: inline-flex;
	}
	.theme-pop {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 40;
		min-width: 150px;
	}
	.theme-check {
		display: inline-flex;
		width: 16px;
	}
</style>
