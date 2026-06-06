<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Confirm email change - Codex</title>
</svelte:head>

<AuthShell title="Confirm email change">
	{#if form}
		{#if form.ok}
			<p class="auth-note" role="status">
				Your email address is updated. Use the new address to sign in from now on.
			</p>
		{:else}
			<p class="form-error auth-note" role="alert">{form.reason}</p>
		{/if}
	{:else if data.valid}
		<p class="auth-note">
			Press the button to make this the email address on your account. Until you do, the account
			keeps its current address.
		</p>
		<form method="POST">
			<button class="btn btn-primary" type="submit">Confirm the change</button>
		</form>
	{:else}
		<p class="form-error auth-note" role="alert">
			This confirmation link is not valid or has expired.
		</p>
	{/if}
	<div class="auth-links">
		<a href={resolve('/login')}>Go to sign in</a>
	</div>
</AuthShell>
