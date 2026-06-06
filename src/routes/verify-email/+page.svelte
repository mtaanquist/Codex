<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Confirm your email - Codex</title>
</svelte:head>

<AuthShell title="Confirm your email">
	{#if form}
		{#if form.verified}
			<p class="auth-note" role="status">
				Thank you. Your email address is confirmed. An administrator reviews your account before you
				can sign in; you will hear from them shortly.
			</p>
		{:else}
			<p class="form-error auth-note" role="alert">
				This confirmation link is not valid. It may have already been used or expired. Try signing
				up again to get a fresh link.
			</p>
		{/if}
	{:else if data.valid}
		<p class="auth-note">Press the button to confirm this email address for your account.</p>
		<form method="POST">
			<button class="btn btn-primary" type="submit">Confirm my email</button>
		</form>
	{:else}
		<p class="form-error auth-note" role="alert">
			This confirmation link is not valid. It may have already been used or expired. Try signing up
			again to get a fresh link.
		</p>
	{/if}
	<div class="auth-links">
		<a href={resolve('/login')}>Back to sign in</a>
	</div>
</AuthShell>
