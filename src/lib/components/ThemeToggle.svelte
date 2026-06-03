<script lang="ts">
	import { browser } from '$app/environment';
	import Icon from './Icon.svelte';

	// Initialised from the attribute the app.html inline script set; reassigned
	// by the toggle (writable derived).
	let theme = $derived<'light' | 'dark'>(
		browser && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
	);

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		document.documentElement.setAttribute('data-theme', theme);
		try {
			localStorage.setItem('codex-theme', theme);
		} catch {
			/* preference just does not persist */
		}
	}
</script>

<button class="icon-btn" type="button" title="Toggle theme" onclick={toggleTheme}>
	{#if theme === 'dark'}<Icon name="sun" />{:else}<Icon name="moon" />{/if}
</button>
