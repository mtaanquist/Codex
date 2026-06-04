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
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
