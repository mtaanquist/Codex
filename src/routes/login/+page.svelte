<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Passkey sign-in is a browser ceremony: fetch a challenge, let the
	// authenticator answer it, post the assertion back, then load the app.
	let passkeyError = $state<string | null>(null);
	let passkeyBusy = $state(false);
	async function signInWithPasskey() {
		passkeyBusy = true;
		passkeyError = null;
		try {
			const optionsResponse = await fetch('/api/passkeys/signin-options', { method: 'POST' });
			if (!optionsResponse.ok) {
				throw new Error((await optionsResponse.json()).message ?? 'Could not start.');
			}
			const { startAuthentication } = await import('@simplewebauthn/browser');
			const response = await startAuthentication({ optionsJSON: await optionsResponse.json() });
			const verifyResponse = await fetch('/api/passkeys/signin', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ response })
			});
			if (!verifyResponse.ok) {
				throw new Error((await verifyResponse.json()).message ?? 'Sign-in failed.');
			}
			location.href = '/';
		} catch (err) {
			passkeyError =
				err instanceof Error && err.name === 'NotAllowedError'
					? 'The passkey prompt was closed before finishing.'
					: err instanceof Error
						? err.message
						: 'Something went wrong signing in.';
			passkeyBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in - Codex</title>
</svelte:head>

<AuthShell title="Sign in" sub="Back to the desk.">
	<form method="POST">
		{#if form?.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		<div class="field">
			<label for="login-email">Email</label>
			<input
				id="login-email"
				class="input"
				type="email"
				name="email"
				value={form?.email ?? ''}
				required
				autocomplete="email"
			/>
		</div>
		<div class="field">
			<label for="login-password">Password</label>
			<input
				id="login-password"
				class="input"
				type="password"
				name="password"
				required
				autocomplete="current-password webauthn"
			/>
			<p class="field-hint">
				<a href={resolve('/forgot-password')}>Forgot your password?</a>
			</p>
		</div>
		<div class="auth-actions">
			<button class="btn btn-primary" type="submit">Sign in</button>
		</div>
	</form>
	{#if passkeyError}
		<p class="form-error auth-note" role="alert">{passkeyError}</p>
	{/if}
	<div class="auth-actions">
		<button
			class="btn btn-secondary"
			type="button"
			disabled={passkeyBusy}
			onclick={signInWithPasskey}
		>
			{passkeyBusy ? 'Waiting for your device...' : 'Use a passkey instead'}
		</button>
	</div>

	<!-- What to do without an account depends on who can make one here. -->
	{#if data.signupMode === 'open'}
		<p class="auth-alt">
			No account yet? <a href={resolve('/signup')}>Create an account</a> and start writing.
		</p>
	{:else if data.signupMode === 'approval'}
		<p class="auth-alt">
			No account yet? Accounts here open by invitation while the work is young.
			<a href={resolve('/signup')}>Request access</a> and you will get an answer rather than a place in
			a queue.
		</p>
	{:else if data.signupMode === 'invite'}
		<p class="auth-alt">
			No account yet? Accounts here open by invitation. Anyone already writing here can invite you,
			so ask them for a code.
		</p>
	{:else}
		<p class="auth-alt">
			This Codex is not taking new accounts at the moment. Ask the person who runs it for access.
		</p>
	{/if}

	{#snippet aside()}
		Running Codex yourself? This is the same page on your own computer. The handbook covers
		<a href={resolve('/docs/[topic]', { topic: 'selfhosting' })}>self-hosting</a>.
	{/snippet}
</AuthShell>
