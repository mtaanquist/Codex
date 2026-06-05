<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

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

<AuthShell title="Sign in">
	<form method="POST">
		<p class="auth-lede">Sign in with your email and password.</p>
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
		</div>
		<button class="btn btn-primary" type="submit">Sign in</button>
	</form>
	{#if passkeyError}
		<p class="form-error auth-note" role="alert">{passkeyError}</p>
	{/if}
	<p class="auth-note">
		<button
			class="btn btn-secondary passkey"
			type="button"
			disabled={passkeyBusy}
			onclick={signInWithPasskey}
		>
			{passkeyBusy ? 'Waiting for your device...' : 'Use a passkey instead'}
		</button>
	</p>
	<div class="auth-links">
		<a href={resolve('/forgot-password')}>Forgot password?</a>
		<a href={resolve('/signup')}>Create an account</a>
	</div>
</AuthShell>

<style>
	.passkey {
		width: 100%;
	}
</style>
