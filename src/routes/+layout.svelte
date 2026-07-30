<script lang="ts">
	import '@fontsource-variable/hanken-grotesk/index.css';
	import '@fontsource/spectral/400.css';
	import '@fontsource/spectral/400-italic.css';
	import '@fontsource/spectral/500.css';
	import '@fontsource/spectral/600.css';
	import '@fontsource-variable/jetbrains-mono/index.css';
	import '$lib/styles/tokens.css';
	import '$lib/styles/theme.css';
	import '$lib/styles/pages.css';
	import '$lib/styles/admin.css';
	import '$lib/styles/editor.css';
	import '$lib/styles/review.css';
	import '$lib/styles/menus.css';
	// Late, so the consolidated primitives win over any screen-local skin.
	import '$lib/styles/primitives.css';
	// Late: the one navigation bar, which beats the bars it replaces.
	import '$lib/styles/chrome.css';
	// Last of all: the secondary surfaces (right-pane panels, the reader, the
	// creation menus), so they beat any screen-local skin they replace.
	import '$lib/styles/surfaces.css';
	// After the surfaces, because the signed-out pages reuse the reading pages'
	// footer and the shared primitives and then set their own type on top.
	import '$lib/styles/public.css';
	import favicon from '$lib/assets/favicon.svg';
	import { browser } from '$app/environment';
	import { applyAppearance } from '$lib/appearance-apply';
	import { followSystemTheme } from '$lib/theme';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import ActivityCenter from '$lib/components/ActivityCenter.svelte';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

	// Marks the document once the client has taken over. Server-rendered markup
	// is clickable before its handlers are attached, so a test that clicks
	// straight after a navigation can hit a button that does nothing; this gives
	// the end-to-end suite something to wait for. Effects only run in the
	// browser, and only once the component tree is mounted.
	$effect(() => {
		document.documentElement.dataset.hydrated = 'true';
	});

	// With no theme choice stored on this device, the palette follows the system
	// and keeps following it while the page is open. A reader who has not chosen
	// gets the theme their system asks for, including when it changes mid-page.
	$effect(() => followSystemTheme());

	// Apply the signed-in user's saved theme and accent, syncing the pre-paint
	// keys so the next load matches without a flash.
	$effect(() => {
		if (!browser || !data.appearance) return;
		applyAppearance(
			data.appearance.theme,
			data.appearance.accent,
			data.appearance.systemLightTheme,
			data.appearance.systemDarkTheme
		);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
{#if data.user}
	<CommandPalette />
	<ActivityCenter />
{/if}
