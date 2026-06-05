<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Reset your password - Codex</title>
</svelte:head>

<AuthShell title="Reset your password">
	{#if form?.sent}
		<p class="auth-note" role="status">
			If an account uses that email address, we have sent a link to reset its password. The link is
			good for one hour.
		</p>
	{:else}
		<form method="POST">
			<p class="auth-lede">
				Enter your email address and we will send you a link to reset your password.
			</p>
			<div class="field">
				<label for="forgot-email">Email</label>
				<input
					id="forgot-email"
					class="input"
					type="email"
					name="email"
					required
					autocomplete="email"
				/>
			</div>
			<button class="btn btn-primary" type="submit">Send reset link</button>
		</form>
	{/if}
	<div class="auth-links">
		<a href={resolve('/login')}>Back to sign in</a>
	</div>
</AuthShell>
