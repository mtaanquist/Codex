<script lang="ts">
	import AuthShell from '$lib/components/AuthShell.svelte';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	// Seeded from the last attempt so a failed recovery-code try stays on that tab.
	// svelte-ignore state_referenced_locally
	let recovery = $state(form?.recovery ?? false);
</script>

<svelte:head>
	<title>Two-factor - Codex</title>
</svelte:head>

<AuthShell title="Two-factor check">
	<form method="POST">
		<input type="hidden" name="mode" value={recovery ? 'recovery' : 'code'} />
		{#if recovery}
			<p class="auth-lede">Enter one of your recovery codes.</p>
		{:else}
			<p class="auth-lede">Enter the 6-digit code from your authenticator app.</p>
		{/if}
		{#if form?.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		{#if recovery}
			<div class="field">
				<label for="totp-recovery">Recovery code</label>
				<input
					id="totp-recovery"
					class="input"
					type="text"
					name="code"
					autocomplete="one-time-code"
					autocapitalize="characters"
					required
				/>
			</div>
		{:else}
			<div class="field">
				<label for="totp-code">Authentication code</label>
				<input
					id="totp-code"
					class="input"
					type="text"
					name="code"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength="6"
					autocomplete="one-time-code"
					required
				/>
			</div>
		{/if}
		<button class="btn btn-primary" type="submit">Verify</button>
	</form>
	<div class="auth-links">
		<button type="button" onclick={() => (recovery = !recovery)}>
			{recovery ? 'Use a code from your app instead' : "Can't use your app? Use a recovery code"}
		</button>
	</div>
</AuthShell>
