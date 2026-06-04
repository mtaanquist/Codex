<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Reset your password - Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	{#if form?.sent}
		<p class="notice" role="status">
			If an account uses that email address, we have sent a link to reset its password. The link is
			good for one hour.
		</p>
		<p><a href={resolve('/login')}>Back to sign in</a></p>
	{:else}
		<form method="POST">
			<p>Enter your email address and we will send you a link to reset your password.</p>
			<label>
				Email
				<input type="email" name="email" required autocomplete="email" />
			</label>
			<button type="submit">Send reset link</button>
		</form>
		<p><a href={resolve('/login')}>Back to sign in</a></p>
	{/if}
</main>

<style>
	main {
		max-width: 22rem;
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
	.notice {
		line-height: 1.5;
	}
</style>
