<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit } from '#lib/autosave-form';
	import { askConfirm } from '#lib/confirm.svelte';
	import { formatDate, formatDateTime } from '#lib/format';
	import { clientDisplayName, PERMISSION_TEXT } from '#lib/mcp-access';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const access = $derived(data.externalAccess);
	const address = $derived(`${data.origin}/api/mcp`);

	// Turning access off disconnects every app, so it asks first when there is
	// one to lose.
	async function onToggle(event: Event & { currentTarget: HTMLFormElement }) {
		const formElement = event.currentTarget;
		const box = event.target as HTMLInputElement;
		if (!box.checked && access.apps.length > 0) {
			const ok = await askConfirm({
				title: 'Turn off access for other apps?',
				body: `This disconnects ${access.apps.length === 1 ? 'the app' : `all ${access.apps.length} apps`} below. To use one again you will have to connect it again.`,
				confirmLabel: 'Turn off and disconnect',
				danger: true
			});
			if (!ok) {
				box.checked = true;
				return;
			}
		}
		formElement.requestSubmit();
	}

	let copied = $state(false);
	function copyAddress() {
		navigator.clipboard.writeText(address).then(() => {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		});
	}
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Connected apps</h1>
	<p class="admin-lede">
		Let an AI app you use read your writing in Codex and leave suggestions for you. An app can never
		change, delete or publish your text.
	</p>
</div>

<div class="admin-block">
	<div class="admin-card">
		<form
			method="POST"
			action="?/setExternalAccess"
			use:enhance={autosaveSubmit}
			onchange={onToggle}
		>
			<div class="toggle-row">
				<label class="toggle">
					<input
						type="checkbox"
						name="enabled"
						aria-label="Allow other apps to connect"
						checked={access.enabled}
					/>
					<span class="toggle-track"></span>
				</label>
				<div style="flex:1;">
					<div class="t-title">Allow other apps to connect</div>
					<div class="t-sub">
						While this is off, no app can connect or read anything. Turning it off disconnects every
						app listed below.
					</div>
				</div>
			</div>
		</form>

		{#if access.enabled}
			<div class="field" style="margin:var(--space-4) 0 0;">
				<label for="mcp-address">Address to give the app</label>
				<div class="copy-field">
					<input id="mcp-address" type="text" value={address} readonly />
					<button type="button" onclick={copyAddress}>
						{copied ? 'Copied' : 'Copy'}
					</button>
				</div>
				<span class="field-hint">
					In the app, add a custom connector (also called a remote MCP server) and paste this
					address. The app then opens a Codex page where you choose what it may do.
				</span>
			</div>
		{/if}
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Apps with access</h2>
		<p class="admin-block-sub">
			Disconnect an app to stop it at once. Changing your password disconnects them all.
		</p>
	</div>
	{#if access.apps.length === 0}
		<div class="admin-card">
			<div class="empty-state tight">
				<p class="empty-state-text">
					{access.enabled
						? 'No app is connected. Paste the address above into an app to connect it.'
						: 'No app is connected. Turn on access above to connect one.'}
				</p>
			</div>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each access.apps as app (app.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">{clientDisplayName(app)}</div>
							<div class="list-sub">
								May: {app.permissions
									.map((permission) => PERMISSION_TEXT[permission].label.toLowerCase())
									.join(', ')}.
							</div>
							<div class="list-sub">
								Connected {formatDate(app.createdAt, page.data.timeZone)}.
								{app.lastUsedAt
									? `Last used ${formatDateTime(app.lastUsedAt, page.data.timeZone)}.`
									: 'Not used yet.'}
							</div>
						</div>
						<form method="POST" action="?/revokeApp">
							<input type="hidden" name="grantId" value={app.id} />
							<button
								type="submit"
								class="btn btn-ghost btn-sm"
								aria-label="Disconnect {clientDisplayName(app)}">Disconnect</button
							>
						</form>
					</div>
				{/each}
			</div>
		</div>
	{/if}
	<div class="settings-actions">
		<FormStatus
			error={form?.scope === 'apps' && form.message ? form.message : null}
			success={form?.scope === 'apps' && form.saved ? 'Done.' : null}
		/>
	</div>
</div>
