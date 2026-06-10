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
	import favicon from '$lib/assets/favicon.svg';
	import { browser } from '$app/environment';
	import { applyAppearance } from '$lib/appearance-apply';
	import HelpModal from '$lib/components/HelpModal.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

	// Apply the signed-in user's saved theme and accent, syncing the pre-paint
	// keys so the next load matches without a flash.
	$effect(() => {
		if (!browser || !data.appearance) return;
		applyAppearance(data.appearance.theme, data.appearance.accent);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
<HelpModal />
{#if data.user}
	<CommandPalette />
{/if}
