<script lang="ts">
	import { tick } from 'svelte';
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
		if (!box.checked && access.apps.length + access.tokens.length > 0) {
			const ok = await askConfirm({
				title: 'Turn off access for other apps?',
				body: 'This disconnects every app and revokes every personal access token below. To use one again you will have to connect it, or make the token, again.',
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

	// The token just made: in the action's answer once, never in the page data.
	const newToken = $derived(form?.scope === 'tokens' && 'token' in form ? form.token : null);
	let tokenCopied = $state(false);
	function copyToken() {
		if (!newToken) return;
		navigator.clipboard.writeText(newToken).then(() => {
			tokenCopied = true;
			setTimeout(() => (tokenCopied = false), 1500);
		});
	}
	// A new token is shown once, above the form that made it, so it is brought
	// into view and focused. A refusal keeps what was typed.
	let tokenField = $state<HTMLInputElement | null>(null);
	const createTokenSubmit: Parameters<typeof enhance>[1] = () => {
		return async ({ result, update }) => {
			await update({ reset: result.type === 'success' });
			if (result.type !== 'success') return;
			await tick();
			tokenField?.scrollIntoView({ block: 'center' });
			tokenField?.focus();
			tokenField?.select();
		};
	};
	// A refusal is shown in the form that was sent, with what was typed kept.
	const keepTyped: Parameters<typeof enhance>[1] = () => {
		return async ({ update }) => {
			await update({ reset: false });
		};
	};
	const lasts = (days: number) => (days === 365 ? '1 year' : `${days} days`);
	const now = Date.now();

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
		{#if !access.enabled}
			<!-- Turning access on lets an app in, so it asks who is there. Turning
			     it off, below, asks for nothing. -->
			<form method="POST" action="?/setExternalAccess" autocomplete="off" use:enhance={keepTyped}>
				<input type="hidden" name="enabled" value="on" />
				<div class="t-title">Allow other apps to connect</div>
				<div class="t-sub">
					This is off, so no app can connect or read anything. To turn it on, confirm it is you.
				</div>
				<div class="field" style="margin-top:var(--space-4);">
					<label for="access-password">Confirm your password</label>
					<input
						id="access-password"
						class="input short"
						type="password"
						name="password"
						required
						autocomplete="current-password"
					/>
				</div>
				{#if access.needsCode}
					<div class="field">
						<label for="access-code">Code from your authenticator app</label>
						<input
							id="access-code"
							class="input short"
							type="text"
							name="code"
							inputmode="numeric"
							required
							autocomplete="one-time-code"
						/>
					</div>
				{/if}
				<div class="settings-actions">
					<button type="submit" class="btn btn-primary">Turn on access for apps</button>
					<FormStatus error={form?.scope === 'access' && form.message ? form.message : null} />
				</div>
			</form>
		{:else}
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
							Turning this off disconnects every app and revokes every token listed below. Turning
							it on again asks for your password.
						</div>
					</div>
				</div>
			</form>
		{/if}

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

<div class="admin-block" id="apps-tokens">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Personal access tokens</h2>
		<p class="admin-block-sub">
			For a script or tool of your own that cannot open the Codex page to ask for access. A token
			works like a password for the address above, so keep it secret. Changing your password revokes
			every token.
		</p>
	</div>

	{#if newToken}
		<div class="admin-card" role="status">
			<div class="field" style="margin:0;">
				<label for="new-token">Your new token</label>
				<div class="copy-field">
					<input id="new-token" type="text" value={newToken} readonly bind:this={tokenField} />
					<button type="button" onclick={copyToken}>{tokenCopied ? 'Copied' : 'Copy'}</button>
				</div>
				<span class="field-hint">
					Copy it now and store it somewhere safe. It is not shown again. In your tool, send it as
					the bearer token with the address above.
				</span>
			</div>
		</div>
	{/if}

	{#if access.tokens.length > 0}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each access.tokens as token (token.id)}
					{@const expired = !token.expiresAt || token.expiresAt.getTime() <= now}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">{token.name}</div>
							<div class="list-sub">
								May: {token.permissions
									.map((permission) => PERMISSION_TEXT[permission].label.toLowerCase())
									.join(', ')}.
							</div>
							<div class="list-sub">
								Made {formatDate(token.createdAt, page.data.timeZone)}.
								{#if expired}
									Expired.
								{:else if token.expiresAt}
									Expires {formatDate(token.expiresAt, page.data.timeZone)}.
								{/if}
								{token.lastUsedAt
									? `Last used ${formatDateTime(token.lastUsedAt, page.data.timeZone)}.`
									: 'Not used yet.'}
							</div>
						</div>
						<form method="POST" action="?/revokePersonalToken">
							<input type="hidden" name="grantId" value={token.id} />
							<button
								type="submit"
								class="btn btn-ghost btn-sm"
								aria-label="Revoke the token {token.name}">Revoke</button
							>
						</form>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if access.enabled}
		<form
			method="POST"
			action="?/createToken"
			class="admin-card"
			autocomplete="off"
			use:enhance={createTokenSubmit}
		>
			<div class="field">
				<label for="token-name">Token name</label>
				<input
					id="token-name"
					class="input short"
					type="text"
					name="name"
					maxlength="60"
					required
				/>
				<span class="field-hint">
					Name the tool that will use it. Suggestions and comments it leaves are shown under this
					name.
				</span>
			</div>
			<div class="field">
				<label class="check-row">
					<input type="checkbox" name="permission" value="suggest" checked />
					{PERMISSION_TEXT.suggest.label}
				</label>
				<p class="field-hint">
					A token can always read your writing. With this ticked it can also add suggested edits and
					comments for you to accept or reject. It can never change your text.
				</p>
			</div>
			<div class="field">
				<label for="token-expiry">Expires after</label>
				<select id="token-expiry" class="select" name="expiresInDays">
					{#each access.tokenExpiryDays as days (days)}
						<option value={days} selected={days === access.tokenDefaultDays}>{lasts(days)}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="token-password">Confirm your password</label>
				<input
					id="token-password"
					class="input short"
					type="password"
					name="password"
					required
					autocomplete="current-password"
				/>
			</div>
			{#if access.needsCode}
				<div class="field">
					<label for="token-code">Code from your authenticator app</label>
					<input
						id="token-code"
						class="input short"
						type="text"
						name="code"
						inputmode="numeric"
						required
						autocomplete="one-time-code"
					/>
					<span class="field-hint">
						Each code works once. If you have just used one, wait for the next.
					</span>
				</div>
			{/if}
			<div class="settings-actions">
				<button type="submit" class="btn btn-primary">Create token</button>
				<FormStatus
					error={form?.scope === 'tokens' && form.message ? form.message : null}
					success={form?.scope === 'tokens' && 'saved' in form && form.saved
						? 'Token revoked.'
						: null}
				/>
			</div>
		</form>
	{:else}
		<div class="admin-card">
			<div class="empty-state tight">
				<p class="empty-state-text">Turn on access above to make a token.</p>
			</div>
		</div>
		<div class="settings-actions">
			<FormStatus
				error={form?.scope === 'tokens' && form.message ? form.message : null}
				success={form?.scope === 'tokens' && 'saved' in form && form.saved
					? 'Token revoked.'
					: null}
			/>
		</div>
	{/if}
</div>
