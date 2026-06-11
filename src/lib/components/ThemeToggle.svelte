<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import { flipTheme } from '$lib/theme';

	// Initialised from the attribute the app.html inline script set; reassigned
	// by the toggle (writable derived).
	let theme = $derived<'light' | 'dark'>(
		browser && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
	);

	// Signed-in viewers get the flip saved to their account; without that, the
	// layout re-applies the stored appearance on the next data refresh (for
	// example after an autosave) and snaps the theme back.
	function toggleTheme() {
		theme = flipTheme(Boolean(page.data.user));
	}
</script>

<button class="icon-btn" type="button" title="Toggle theme" onclick={toggleTheme}>
	{#if theme === 'dark'}<Icon name="sun" />{:else}<Icon name="moon" />{/if}
</button>
