<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// An invite code gets you in without waiting, so a Codex that takes codes
	// asks for an account rather than for permission.
	const title = $derived(
		data.mode === 'none'
			? 'New accounts are closed'
			: data.mode === 'approval'
				? 'Request access'
				: 'Create an account'
	);
	const sub = $derived(
		data.mode === 'approval'
			? 'Accounts open by invitation while the work is young. Ask, and you get an answer either way.'
			: data.mode === 'invite'
				? 'An invite code gets you in. If you do not have one, ask someone who already writes here.'
				: undefined
	);
</script>

<svelte:head>
	<title>{title} - Codex</title>
</svelte:head>

<AuthShell {title} sub={data.mode === 'none' ? undefined : sub}>
	{#if data.mode === 'none'}
		<p class="auth-note" role="status">
			This Codex is not taking new accounts. Ask the person who runs it for access.
		</p>
		<p class="auth-alt"><a href={resolve('/login')}>Back to sign in</a></p>
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
		<p class="auth-alt"><a href={resolve('/login')}>Back to sign in</a></p>
	{:else}
		<form method="POST">
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
			<div class="auth-actions">
				<button class="btn btn-primary" type="submit">Create account</button>
			</div>
		</form>
		<p class="auth-alt">
			Already have an account? <a href={resolve('/login')}>Sign in</a>.
		</p>
	{/if}

	{#snippet aside()}
		You can also
		<a href={resolve('/docs/[topic]', { topic: 'selfhosting' })}>run Codex on your own computer</a>,
		where there is no invite to wait for.
	{/snippet}
</AuthShell>
