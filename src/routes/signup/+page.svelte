<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Create an account - Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	{#if form?.sent}
		<p class="notice" role="status">
			{#if form.invited}
				Check your email. We have sent a link to confirm your address. Once you have confirmed it,
				you can sign in.
			{:else}
				Check your email. We have sent a link to confirm your address. Once you have confirmed it,
				an administrator reviews your account before you can sign in.
			{/if}
		</p>
		<p><a href={resolve('/login')}>Back to sign in</a></p>
	{:else}
		<form method="POST">
			<p>Create an account to start writing.</p>
			{#if form?.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			<label>
				Display name
				<input
					type="text"
					name="displayName"
					value={form?.displayName ?? ''}
					required
					autocomplete="name"
				/>
			</label>
			<label>
				Email
				<input type="email" name="email" value={form?.email ?? ''} required autocomplete="email" />
			</label>
			<label>
				Password
				<input type="password" name="password" required minlength="8" autocomplete="new-password" />
			</label>
			<label>
				Invite code (optional)
				<input
					type="text"
					name="inviteCode"
					value={form?.inviteCode ?? data.prefillCode}
					autocomplete="off"
					spellcheck="false"
				/>
				<span class="hint">If you have an invite code, enter it to skip the approval wait.</span>
			</label>
			<button type="submit">Create account</button>
		</form>
		<p><a href={resolve('/login')}>Already have an account? Sign in</a></p>
	{/if}
</main>

<style>
	main {
		max-width: 20rem;
		margin: 15vh auto 0;
		font-family: system-ui, sans-serif;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.error {
		color: #b00020;
	}
	.hint {
		font-size: 0.8125rem;
		color: #666;
	}
	.notice {
		line-height: 1.5;
	}
</style>
