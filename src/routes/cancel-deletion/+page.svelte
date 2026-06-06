<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Cancel deletion - Codex</title>
</svelte:head>

<AuthShell title="Cancel deletion">
	{#if form}
		{#if form.cancelled}
			<p class="auth-note" role="status">
				Your account deletion is cancelled and your account is active again. You can sign in as
				usual. Any pages you had published stay unpublished; publish them again when you are ready.
			</p>
		{:else}
			<p class="form-error auth-note" role="alert">
				This cancellation link is not valid. It may have already been used, expired, or the deletion
				may have already run. If you still have access, sign in to check.
			</p>
		{/if}
	{:else if data.valid}
		<p class="auth-note">
			Press the button to cancel the scheduled deletion and keep your account.
		</p>
		<form method="POST">
			<button class="btn btn-primary" type="submit">Keep my account</button>
		</form>
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
