<script lang="ts">
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Review emails - Codex</title>
</svelte:head>

<AuthShell title="Review emails">
	{#if data.optedOut}
		<p class="auth-note" role="status">
			Done. You will get no more emails about this review. Your review link keeps working, and any
			comments you left stay where they are.
		</p>
	{:else}
		<p class="form-error auth-note" role="alert">
			This link is not valid. It may be incomplete; try copying the whole address from the email.
		</p>
	{/if}
</AuthShell>
