<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A link that fails when used drops back to the request form.
	const usable = $derived(data.token !== '' && !form?.message);
	const message = $derived(form?.message ?? data.message);
</script>

<svelte:head>
	<title>Sign in with a link - Codex</title>
</svelte:head>

<AuthShell title="Sign in with a link">
	{#if usable}
		<form method="POST" action="?/use">
			<p class="auth-lede">
				Select the button to finish signing in. If your account uses two-factor authentication, you
				are asked for a code next.
			</p>
			<input type="hidden" name="token" value={data.token} />
			<div class="auth-actions">
				<button class="btn btn-primary" type="submit">Sign in</button>
			</div>
		</form>
	{:else if form && 'sent' in form}
		<p class="auth-note" role="status">
			If an account uses that email address, we have sent it a sign-in link. The link is good for {data.minutes}
			minutes and works once.
		</p>
	{:else}
		<form method="POST" action="?/send">
			{#if message}
				<p class="form-error" role="alert">{message}</p>
			{/if}
			<p class="auth-lede">
				Enter your email address and we will send you a link that signs you in without your
				password.
			</p>
			<div class="field">
				<label for="link-email">Email</label>
				<input
					id="link-email"
					class="input"
					type="email"
					name="email"
					required
					autocomplete="email"
				/>
			</div>
			<div class="auth-actions">
				<button class="btn btn-primary" type="submit">Send sign-in link</button>
			</div>
		</form>
	{/if}
	<div class="auth-links">
		<a href={resolve('/login')}>Back to sign in</a>
	</div>
</AuthShell>
