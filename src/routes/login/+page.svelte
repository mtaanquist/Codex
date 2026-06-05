<script lang="ts">
	import { resolve } from '$app/paths';
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

<main>
	<h1>Codex</h1>
	<form method="POST">
		<p>Sign in with your email and password.</p>
		{#if form?.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<label>
			Email
			<input type="email" name="email" value={form?.email ?? ''} required autocomplete="email" />
		</label>
		<label>
			Password
			<input type="password" name="password" required autocomplete="current-password webauthn" />
		</label>
		<button type="submit">Sign in</button>
	</form>
	{#if passkeyError}
		<p class="error" role="alert">{passkeyError}</p>
	{/if}
	<button type="button" class="passkey" disabled={passkeyBusy} onclick={signInWithPasskey}>
		{passkeyBusy ? 'Waiting for your device...' : 'Use a passkey instead'}
	</button>
	<p><a href={resolve('/forgot-password')}>Forgot password?</a></p>
	<p><a href={resolve('/signup')}>Create an account</a></p>
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
	.passkey {
		width: 100%;
		margin-top: 1rem;
	}
</style>
