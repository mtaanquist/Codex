<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	// Seeded from the last attempt so a failed recovery-code try stays on that tab.
	// svelte-ignore state_referenced_locally
	let recovery = $state(form?.recovery ?? false);
</script>

<svelte:head>
	<title>Two-factor - Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	<form method="POST">
		<input type="hidden" name="mode" value={recovery ? 'recovery' : 'code'} />
		{#if recovery}
			<p>Enter one of your recovery codes.</p>
		{:else}
			<p>Enter the 6-digit code from your authenticator app.</p>
		{/if}
		{#if form?.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if recovery}
			<label>
				Recovery code
				<input
					type="text"
					name="code"
					autocomplete="one-time-code"
					autocapitalize="characters"
					required
				/>
			</label>
		{:else}
			<label>
				Authentication code
				<input
					type="text"
					name="code"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength="6"
					autocomplete="one-time-code"
					required
				/>
			</label>
		{/if}
		<button type="submit">Verify</button>
	</form>
	<p>
		<button type="button" class="link" onclick={() => (recovery = !recovery)}>
			{recovery ? 'Use a code from your app instead' : "Can't use your app? Use a recovery code"}
		</button>
	</p>
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
	.link {
		background: none;
		border: 0;
		padding: 0;
		color: #1a4a8a;
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}
</style>
