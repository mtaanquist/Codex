<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Create an account - Codex</title>
</svelte:head>

<AuthShell title="Create an account">
	{#if form?.sent}
		<p class="auth-note" role="status">
			{#if form.invited}
				Check your email. We have sent a link to confirm your address. Once you have confirmed it,
				you can sign in.
			{:else}
				Check your email. We have sent a link to confirm your address. Once you have confirmed it,
				an administrator reviews your account before you can sign in.
			{/if}
		</p>
		<div class="auth-links">
			<a href={resolve('/login')}>Back to sign in</a>
		</div>
	{:else}
		<form method="POST">
			<p class="auth-lede">Create an account to start writing.</p>
			{#if form?.message}
				<p class="form-error" role="alert">{form.message}</p>
			{/if}
			<div class="field">
				<label for="signup-name">Display name</label>
				<input
					id="signup-name"
					class="input"
					type="text"
					name="displayName"
					value={form?.displayName ?? ''}
					required
					autocomplete="name"
				/>
			</div>
			<div class="field">
				<label for="signup-email">Email</label>
				<input
					id="signup-email"
					class="input"
					type="email"
					name="email"
					value={form?.email ?? ''}
					required
					autocomplete="email"
				/>
			</div>
			<div class="field">
				<label for="signup-password">Password</label>
				<input
					id="signup-password"
					class="input"
					type="password"
					name="password"
					required
					minlength="8"
					autocomplete="new-password"
				/>
			</div>
			<div class="field">
				<label for="signup-invite">Invite code (optional)</label>
				<input
					id="signup-invite"
					class="input"
					type="text"
					name="inviteCode"
					value={form?.inviteCode ?? data.prefillCode}
					autocomplete="off"
					spellcheck="false"
				/>
				<span class="field-hint">
					If you have an invite code, enter it to skip the approval wait.
				</span>
			</div>
			<button class="btn btn-primary" type="submit">Create account</button>
		</form>
		<div class="auth-links">
			<a href={resolve('/login')}>Already have an account? Sign in</a>
		</div>
	{/if}
</AuthShell>
