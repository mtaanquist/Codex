<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Confirm email change - Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	{#if data.ok}
		<p class="notice" role="status">
			Your email address is updated. Use the new address to sign in from now on.
		</p>
	{:else}
		<p class="error" role="alert">{data.reason}</p>
	{/if}
	<p><a href={resolve('/login')}>Go to sign in</a></p>
</main>

<style>
	main {
		max-width: 24rem;
		margin: 15vh auto 0;
		font-family: system-ui, sans-serif;
	}
	.notice,
	.error {
		line-height: 1.5;
	}
	.error {
		color: #b00020;
	}
</style>
