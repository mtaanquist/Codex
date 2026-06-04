<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Confirm your email - Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	{#if data.verified}
		<p class="notice" role="status">
			Thank you. Your email address is confirmed. An administrator reviews your account before you
			can sign in; you will hear from them shortly.
		</p>
	{:else}
		<p class="error" role="alert">
			This confirmation link is not valid. It may have already been used or expired. Try signing up
			again to get a fresh link.
		</p>
	{/if}
	<p><a href={resolve('/login')}>Back to sign in</a></p>
</main>

<style>
	main {
		max-width: 22rem;
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
