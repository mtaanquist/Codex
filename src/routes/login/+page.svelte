<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
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
			<input type="password" name="password" required autocomplete="current-password" />
		</label>
		<button type="submit">Sign in</button>
	</form>
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
</style>
