<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Cancel deletion - Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	{#if data.cancelled}
		<p class="notice" role="status">
			Your account deletion is cancelled and your account is active again. You can sign in as usual.
			Any pages you had published stay unpublished; publish them again when you are ready.
		</p>
	{:else}
		<p class="error" role="alert">
			This cancellation link is not valid. It may have already been used, expired, or the deletion
			may have already run. If you still have access, sign in to check.
		</p>
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
