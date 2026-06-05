<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Confirm email change - Codex</title>
</svelte:head>

<AuthShell title="Confirm email change">
	{#if data.ok}
		<p class="auth-note" role="status">
			Your email address is updated. Use the new address to sign in from now on.
		</p>
	{:else}
		<p class="form-error auth-note" role="alert">{data.reason}</p>
	{/if}
	<div class="auth-links">
		<a href={resolve('/login')}>Go to sign in</a>
	</div>
</AuthShell>
