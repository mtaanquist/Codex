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
	{#if data.mode === 'none'}
		<p class="auth-note" role="status">
			This Codex is not taking new accounts. Ask the person who runs it for access.
		</p>
		<div class="auth-links">
			<a href={resolve('/login')}>Back to sign in</a>
		</div>
	{:else if form?.sent}
		<p class="auth-note" role="status">
			{#if form.pendingApproval}
				Check your email. We have sent a link to confirm your address. Once you have confirmed it,
				an administrator reviews your account before you can sign in.
			{:else}
				Check your email. We have sent a link to confirm your address. Once you have confirmed it,
				you can sign in.
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
			{#if data.mode !== 'open'}
				<div class="field">
					<label for="signup-invite">
						{data.mode === 'invite' ? 'Invite code' : 'Invite code (optional)'}
					</label>
					<input
						id="signup-invite"
						class="input"
						type="text"
						name="inviteCode"
						value={form?.inviteCode ?? data.prefillCode}
						required={data.mode === 'invite'}
						autocomplete="off"
						spellcheck="false"
					/>
					<span class="field-hint">
						{data.mode === 'invite'
							? 'An invite code is needed to create an account here.'
							: 'If you have an invite code, enter it to skip the approval wait.'}
					</span>
				</div>
			{/if}
			<button class="btn btn-primary" type="submit">Create account</button>
		</form>
		<div class="auth-links">
			<a href={resolve('/login')}>Already have an account? Sign in</a>
		</div>
	{/if}
</AuthShell>
