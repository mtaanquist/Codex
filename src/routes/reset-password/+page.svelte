<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Choose a new password - Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	{#if form?.done}
		<p class="notice" role="status">Your password is updated. You can sign in with it now.</p>
		<p><a href={resolve('/login')}>Go to sign in</a></p>
	{:else}
		<form method="POST">
			<p>Choose a new password.</p>
			{#if form?.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			<input type="hidden" name="token" value={data.token} />
			<label>
				New password
				<input type="password" name="password" required minlength="8" autocomplete="new-password" />
			</label>
			<button type="submit">Update password</button>
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
	.error {
		color: #b00020;
	}
</style>
