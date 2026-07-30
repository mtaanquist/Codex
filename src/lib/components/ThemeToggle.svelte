<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import { cycleTheme, currentTheme, nextTheme } from '$lib/theme';
	import type { ConcreteTheme } from '$lib/appearance';

	// The theme control in the app bar. It walks dark -> light -> warm, the
	// same three palettes in the same order for every shell. A signed-in
	// viewer gets the choice saved to their account; a guest reviewer or a
	// reader keeps it in this browser only.

	// Initialised from the attribute the app.html inline script set; reassigned
	// by the control.
	let theme = $state<ConcreteTheme>(browser ? currentTheme() : 'dark');

	// The icon shows what clicking gives you, matching the label.
	const next = $derived(nextTheme(theme));
	const label = $derived(`Theme: ${theme}. Click for ${next}.`);
</script>

<button
	class="icon-btn"
	type="button"
	title={label}
	aria-label={label}
	onclick={() => (theme = cycleTheme(Boolean(page.data.user)))}
>
	{#if next === 'light'}<Icon name="sun" />{:else if next === 'warm'}<Icon
			name="sunset"
		/>{:else}<Icon name="moon" />{/if}
</button>
