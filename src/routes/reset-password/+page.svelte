<script lang="ts">
	import { MIN_PASSWORD } from '$lib/password';
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Choose a new password - Codex</title>
</svelte:head>

<AuthShell title="Choose a new password">
	{#if form?.done}
		<p class="auth-note" role="status">Your password is updated. You can sign in with it now.</p>
		<div class="auth-links">
			<a href={resolve('/login')}>Go to sign in</a>
		</div>
	{:else}
		<form method="POST">
			<p class="auth-lede">Choose a new password.</p>
			{#if form?.message}
				<p class="form-error" role="alert">{form.message}</p>
			{/if}
			<input type="hidden" name="token" value={data.token} />
			<div class="field">
				<label for="reset-password">New password</label>
				<input
					id="reset-password"
					class="input"
					type="password"
					name="password"
					required
					minlength={MIN_PASSWORD}
					aria-describedby="reset-password-hint"
					autocomplete="new-password"
				/>
				<span class="field-hint" id="reset-password-hint">
					At least {MIN_PASSWORD} characters.
				</span>
			</div>
			<div class="auth-actions">
				<button class="btn btn-primary" type="submit">Update password</button>
			</div>
		</form>
		<div class="auth-links">
			<a href={resolve('/login')}>Back to sign in</a>
		</div>
	{/if}
</AuthShell>
