<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import { clientDisplayName } from '#lib/mcp-access';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Once the writer has answered, the server names the app's address to go
	// to. Left as a link too, for a browser that does not follow it.
	const continueTo = $derived(form && 'continueTo' in form ? form.continueTo : null);
	$effect(() => {
		if (continueTo) window.location.replace(continueTo);
	});

	const appName = $derived(data.status === 'ok' ? clientDisplayName(data.client) : '');
</script>

<svelte:head>
	<title>Connect an app - Codex</title>
</svelte:head>

{#if continueTo}
	<AuthShell title="Returning to the app">
		<p class="auth-note" role="status">
			You are being sent back to the app. If nothing happens, use the link below.
		</p>
		<div class="auth-links">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the app's own address, outside this site -->
			<a href={continueTo} rel="noreferrer">Continue</a>
		</div>
	</AuthShell>
{:else if data.status === 'invalid'}
	<AuthShell title="This link does not work">
		<p class="form-error auth-note" role="alert">{data.message}</p>
		<div class="auth-links">
			<a href={resolve('/')}>Go to your library</a>
		</div>
	</AuthShell>
{:else if !data.accessOn}
	<AuthShell title="Connect an app" sub="{appName} wants to connect to your Codex account.">
		<p class="auth-note">
			Access for other apps is turned off for your account. To connect this app, turn it on under
			Account, Connected apps, then go back to the app and connect again.
		</p>
		<div class="auth-links">
			<a href={resolve('/account/[[section]]', { section: 'apps' })}>Open Connected apps</a>
		</div>
	</AuthShell>
{:else}
	<AuthShell
		title="Connect an app"
		sub="{appName} wants to connect to your Codex account ({data.email})."
	>
		{#if form && 'message' in form && form.message}
			<p class="form-error auth-note" role="alert">{form.message}</p>
		{/if}
		<p class="auth-lede">
			{#if data.connected}
				This app is already connected. Allowing it again replaces what it may do with your choice
				below.
			{:else}
				Only allow this if you started it yourself, from an app you trust.
			{/if}
			{#if data.local}
				The app runs on this computer.
			{:else if data.redirectHost !== data.client.host}
				After you answer, you are sent back to {data.redirectHost}.
			{/if}
		</p>
		<form method="POST" action="?/allow">
			{#each data.fields as field (field.name)}
				<input type="hidden" name={field.name} value={field.value} />
			{/each}
			<fieldset class="consent-list">
				<legend class="consent-legend">Allow this app to</legend>
				{#each data.permissions as permission (permission.id)}
					<label class="choice">
						<input
							type="checkbox"
							name="permission"
							value={permission.id}
							checked={permission.checked || permission.required}
							disabled={permission.required}
							aria-describedby="consent-{permission.id}-hint"
						/>
						<span>
							{permission.label}
							<span class="choice-hint" id="consent-{permission.id}-hint">
								{permission.description}
							</span>
						</span>
					</label>
				{/each}
			</fieldset>
			<p class="auth-note">
				The app can never change, delete or publish your writing. You can disconnect it at any time
				under Account, Connected apps.
			</p>
			<div class="auth-actions">
				<button class="btn btn-primary" type="submit">Allow</button>
			</div>
			<div class="auth-actions">
				<button class="btn btn-secondary" type="submit" formaction="?/deny">Do not allow</button>
			</div>
		</form>
	</AuthShell>
{/if}

<style>
	.consent-list {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.consent-legend {
		padding: 0;
		margin-bottom: var(--space-2);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-muted);
	}
</style>
