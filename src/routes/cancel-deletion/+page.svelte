<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Cancel deletion - Codex</title>
</svelte:head>

<AuthShell title="Cancel deletion">
	{#if data.cancelled}
		<p class="auth-note" role="status">
			Your account deletion is cancelled and your account is active again. You can sign in as usual.
			Any pages you had published stay unpublished; publish them again when you are ready.
		</p>
	{:else}
		<p class="form-error auth-note" role="alert">
			This cancellation link is not valid. It may have already been used, expired, or the deletion
			may have already run. If you still have access, sign in to check.
		</p>
	{/if}
	<div class="auth-links">
		<a href={resolve('/login')}>Go to sign in</a>
	</div>
</AuthShell>
