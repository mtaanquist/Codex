<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatDateTime } from '$lib/format';
	import ExportPanel from '$lib/components/ExportPanel.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Adding a passkey is a browser ceremony, not a form post: fetch the
	// creation options, hand them to the authenticator, post the result back.
	let passkeyName = $state('');
	let passkeyPassword = $state('');
	let passkeyError = $state<string | null>(null);
	let passkeyAdded = $state(false);
	let passkeyBusy = $state(false);
	async function addPasskey() {
		passkeyBusy = true;
		passkeyError = null;
		passkeyAdded = false;
		try {
			// Adding a passkey re-checks the current password, the same as removing
			// one, so a borrowed session cannot plant a durable credential.
			const optionsResponse = await fetch('/api/passkeys/register-options', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password: passkeyPassword })
			});
			if (!optionsResponse.ok) {
				throw new Error((await optionsResponse.json()).message ?? 'Could not start.');
			}
			const { startRegistration } = await import('@simplewebauthn/browser');
			const response = await startRegistration({ optionsJSON: await optionsResponse.json() });
			const verifyResponse = await fetch('/api/passkeys/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ response, name: passkeyName })
			});
			if (!verifyResponse.ok) {
				throw new Error((await verifyResponse.json()).message ?? 'Could not verify.');
			}
			passkeyName = '';
			passkeyPassword = '';
			passkeyAdded = true;
			await invalidateAll();
		} catch (err) {
			// A dismissed browser prompt arrives as NotAllowedError; say it plainly.
			passkeyError =
				err instanceof Error && err.name === 'NotAllowedError'
					? 'The passkey prompt was closed before finishing.'
					: err instanceof Error
						? err.message
						: 'Something went wrong adding the passkey.';
		} finally {
			passkeyBusy = false;
		}
	}

	function onDate(date: Date): string {
		return new Date(date).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		});
	}

	// The segmented setup code. Each box holds one digit; the joined value posts
	// as `code`. A fresh page load (after a failed confirm) starts empty.
	let otpDigits = $state(['', '', '', '', '', '']);
	let otpBoxes = $state<HTMLElement>();
	const otpCode = $derived(otpDigits.join(''));
	function otpInputs(): HTMLInputElement[] {
		return otpBoxes ? Array.from(otpBoxes.querySelectorAll('input')) : [];
	}
	function onOtpInput(i: number, event: Event) {
		const el = event.target as HTMLInputElement;
		const digit = el.value.replace(/\D/g, '').slice(-1);
		otpDigits[i] = digit;
		el.value = digit;
		if (digit && i < 5) otpInputs()[i + 1]?.focus();
	}
	function onOtpKey(i: number, event: KeyboardEvent) {
		if (event.key === 'Backspace' && !otpDigits[i] && i > 0) otpInputs()[i - 1]?.focus();
	}
	function onOtpPaste(event: ClipboardEvent) {
		const text = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
		if (!text) return;
		event.preventDefault();
		otpDigits = Array.from({ length: 6 }, (_, k) => text[k] ?? '');
		otpInputs().forEach((input, k) => (input.value = otpDigits[k]));
		otpInputs()[Math.min(text.length, 5)]?.focus();
	}

	function copyText(text: string) {
		navigator.clipboard?.writeText(text).catch(() => {});
	}
	function downloadCodes(codes: string[]) {
		const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'codex-recovery-codes.txt';
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Security</h1>
	<p class="admin-lede">Your email, password, and the devices currently signed in.</p>
</div>

<div class="admin-block">
	<div class="settings-group">
		<header class="settings-group-header">
			<h2 class="settings-group-title">Email</h2>
			<p class="settings-group-subtitle">
				Your address is <strong>{data.email}</strong>. Changing it sends a confirmation link to the
				new address; your current address stays until you confirm.
			</p>
		</header>
		<form method="POST" action="?/changeEmail">
			<div class="field">
				<label for="new-email">New email</label>
				<input
					id="new-email"
					class="input"
					type="email"
					name="newEmail"
					required
					autocomplete="email"
				/>
			</div>
			<div class="field">
				<label for="email-password">Confirm your password</label>
				<input
					id="email-password"
					class="input"
					type="password"
					name="password"
					required
					autocomplete="current-password"
				/>
			</div>
			<div class="settings-actions">
				{#if form?.scope === 'email' && form.message}
					<span class="field-hint" role="alert" style="color:var(--danger);">{form.message}</span>
				{:else if form?.scope === 'email' && form.sent}
					<span class="field-hint" role="status" style="color:var(--status-final);"
						>Check your new inbox for a confirmation link.</span
					>
				{/if}
				<button type="submit" class="btn btn-primary">Change email</button>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="settings-group">
		<header class="settings-group-header">
			<h2 class="settings-group-title">Password</h2>
			<p class="settings-group-subtitle">Change the password you use to sign in.</p>
		</header>
		<form method="POST" action="?/changePassword">
			<div class="field">
				<label for="current-password">Current password</label>
				<input
					id="current-password"
					class="input"
					type="password"
					name="currentPassword"
					required
					autocomplete="current-password"
				/>
			</div>
			<div class="field">
				<label for="new-password">New password</label>
				<input
					id="new-password"
					class="input"
					type="password"
					name="newPassword"
					required
					minlength="8"
					autocomplete="new-password"
				/>
			</div>
			<div class="settings-actions">
				{#if form?.scope === 'password' && form.message}
					<span class="field-hint" role="alert" style="color:var(--danger);">{form.message}</span>
				{:else if form?.scope === 'password' && form.saved}
					<span class="field-hint" role="status" style="color:var(--status-final);"
						>Password changed. Other devices were signed out.</span
					>
				{/if}
				<button type="submit" class="btn btn-primary">Update password</button>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Two-factor authentication</h2>
		<p class="admin-block-sub">
			Add a one-time code from an authenticator app on top of your password. Codex uses standard
			TOTP, so any app works - Aegis, Ente Auth, 1Password, Google Authenticator.
		</p>
	</div>

	<div class="admin-card">
		<div class="tfa-status">
			<span class="tfa-ic">
				{#if data.twoFactor.status === 'on'}
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z" /><path d="m9 12 2 2 4-4" /></svg
					>
				{:else}
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><rect x="5" y="11" width="14" height="10" rx="2" /><path
							d="M8 11V7a4 4 0 0 1 8 0v4"
						/></svg
					>
				{/if}
			</span>
			<div class="tfa-body">
				<div class="tfa-titlerow">
					<span class="tfa-title">Authenticator app</span>
					{#if data.twoFactor.status === 'on'}
						<span class="tfa-badge">On</span>
					{:else if data.twoFactor.status === 'pending'}
						<span class="tfa-badge">Setting up</span>
					{:else}
						<span class="tfa-badge">Off</span>
					{/if}
				</div>
				<p class="tfa-sub">
					{#if data.twoFactor.status === 'on'}
						{#if data.twoFactor.confirmedAt}Enabled {onDate(data.twoFactor.confirmedAt)} -
						{/if}you'll be asked for a code on new devices. {data.twoFactor.recoveryRemaining} recovery
						codes remain.
					{:else if data.twoFactor.status === 'pending'}
						Scan the code, then enter a code to confirm.
					{:else if !data.twoFactor.available}
						Two-factor authentication is not set up on this instance.
					{:else}
						Not enabled. Anyone with your password can sign in.
					{/if}
				</p>
			</div>
			<div class="tfa-status-action">
				{#if data.twoFactor.status === 'on'}
					<div class="tfa-on-actions">
						<form method="POST" action="?/regenerateRecovery" class="tfa-guard">
							<input
								type="password"
								name="password"
								placeholder="Current password"
								autocomplete="current-password"
								aria-label="Current password"
								required
							/>
							<button type="submit" class="btn btn-secondary btn-sm">Recovery codes</button>
						</form>
						<form method="POST" action="?/disableTotp" class="tfa-guard">
							<input
								type="password"
								name="password"
								placeholder="Current password"
								autocomplete="current-password"
								aria-label="Current password"
								required
							/>
							<button type="submit" class="btn btn-ghost btn-sm" style="color:var(--danger);"
								>Turn off</button
							>
						</form>
					</div>
				{:else if data.twoFactor.status === 'pending'}
					<form method="POST" action="?/cancelTotp">
						<button type="submit" class="btn btn-ghost">Cancel</button>
					</form>
				{:else if data.twoFactor.available}
					<form method="POST" action="?/startTotp">
						<button type="submit" class="btn btn-primary">Set up</button>
					</form>
				{/if}
			</div>
		</div>

		{#if form?.scope === 'totp' && form.message}
			<p class="field-hint" role="alert" style="color:var(--danger); margin-top:var(--space-2);">
				{form.message}
			</p>
		{/if}

		{#if data.twoFactor.status === 'pending' && data.totpSetup}
			<div class="tfa-setup">
				<div class="tfa-step">
					<span class="tfa-step-n">1</span>
					<div class="tfa-step-main">
						<div class="tfa-step-title">Scan this with your authenticator app</div>
						<p class="tfa-step-sub">Or enter the key by hand if you cannot scan.</p>
						<div class="tfa-scan">
							<div class="qr">
								<img
									src={data.totpSetup.qr}
									alt="QR code for your authenticator app"
									style="width:100%;height:100%"
								/>
							</div>
							<div class="tfa-scan-alt">
								<div class="lbl">Setup key</div>
								<p class="hint">
									Account: <span class="mono">Codex ({data.email})</span>
								</p>
								<div class="copy-field">
									<input id="totp-secret" type="text" value={data.totpSetup.secret} readonly />
									<button type="button" onclick={() => copyText(data.totpSetup?.secret ?? '')}
										>Copy</button
									>
								</div>
								<p class="hint" style="margin-top:9px;">
									Time-based, 6 digits, refreshes every 30s.
								</p>
							</div>
						</div>
					</div>
				</div>
				<div class="tfa-step">
					<span class="tfa-step-n">2</span>
					<div class="tfa-step-main">
						<div class="tfa-step-title">Enter the 6-digit code</div>
						<p class="tfa-step-sub">
							Type the current code shown in your app to confirm it's set up.
						</p>
						<form method="POST" action="?/confirmTotp" id="totp-confirm">
							<input type="hidden" name="code" value={otpCode} />
							<div class="otp-input" bind:this={otpBoxes} onpaste={onOtpPaste}>
								{#each otpDigits as digit, i (i)}
									{#if i === 3}<span class="otp-gap"></span>{/if}
									<input
										type="text"
										inputmode="numeric"
										maxlength="1"
										value={digit}
										aria-label={`Digit ${i + 1}`}
										oninput={(event) => onOtpInput(i, event)}
										onkeydown={(event) => onOtpKey(i, event)}
									/>
								{/each}
							</div>
						</form>
					</div>
				</div>
				<div class="settings-actions">
					<form method="POST" action="?/cancelTotp">
						<button type="submit" class="btn btn-ghost">Cancel</button>
					</form>
					<button type="submit" form="totp-confirm" class="btn btn-primary"
						>Verify and turn on</button
					>
				</div>
			</div>
		{/if}

		{#if form?.scope === 'totp' && form.recoveryCodes}
			{@const codes = form.recoveryCodes}
			<div class="tfa-setup">
				<div class="tfa-step-title">Recovery codes</div>
				<p class="tfa-step-sub">
					Save these somewhere safe. Each one signs you in once if you lose your authenticator. They
					will not be shown in full again.
				</p>
				<div class="recovery-note">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path
							d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
						/><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12" y2="17" /></svg
					>
					<span>Treat these like passwords. Anyone with one can get into your account.</span>
				</div>
				<div class="recovery-grid">
					{#each codes as code (code)}<code>{code}</code>{/each}
				</div>
				<div class="recovery-actions">
					<button
						type="button"
						class="btn btn-secondary btn-sm"
						onclick={() => copyText(codes.join('\n'))}>Copy all</button
					>
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => downloadCodes(codes)}
						>Download .txt</button
					>
					<form
						method="POST"
						action="?/regenerateRecovery"
						class="tfa-guard"
						style="margin-left:auto;"
					>
						<input
							type="password"
							name="password"
							placeholder="Current password"
							autocomplete="current-password"
							aria-label="Current password"
							required
						/>
						<button type="submit" class="btn btn-ghost btn-sm">Regenerate</button>
					</form>
				</div>
			</div>
		{/if}
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Passkeys</h2>
		<p class="admin-block-sub">
			Sign in with your device's screen lock or a security key instead of typing your password. You
			can add a passkey on each device you write from.
		</p>
	</div>
	<div class="admin-card">
		{#if !data.passkeysAvailable}
			<p class="tfa-sub">
				Passkeys need APP_SECRET set on the server. Ask whoever runs this instance.
			</p>
		{:else}
			{#if data.passkeys.length > 0}
				<div class="attn-list" style="margin-bottom:var(--space-4);">
					{#each data.passkeys as passkey (passkey.id)}
						<div class="user-row">
							<div class="user-row-identity">
								<p class="user-row-name">{passkey.name ?? 'Passkey'}</p>
								<p class="user-row-email">
									Added {onDate(passkey.createdAt)}{passkey.lastUsedAt
										? ` - last used ${formatDateTime(passkey.lastUsedAt)}`
										: ''}
								</p>
							</div>
							<div class="user-row-actions">
								<form method="POST" action="?/removePasskey" class="tfa-guard">
									<input type="hidden" name="passkeyId" value={passkey.id} />
									<input
										type="password"
										name="password"
										placeholder="Current password"
										autocomplete="current-password"
										aria-label="Current password"
										required
									/>
									<button type="submit" class="btn btn-ghost btn-sm">Remove</button>
								</form>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if form?.scope === 'passkeys' && form.message}
				<p class="field-hint" role="alert" style="color:var(--danger);">{form.message}</p>
			{:else if form?.scope === 'passkeys' && 'removed' in form && form.removed}
				<p class="field-hint" role="status" style="color:var(--status-final);">Passkey removed.</p>
			{/if}
			{#if passkeyError}
				<p class="field-hint" role="alert" style="color:var(--danger);">{passkeyError}</p>
			{:else if passkeyAdded}
				<p class="field-hint" role="status" style="color:var(--status-final);">Passkey added.</p>
			{/if}
			<div class="settings-actions" style="justify-content:flex-start;">
				<input
					class="input"
					type="text"
					placeholder="Name this passkey, e.g. laptop"
					aria-label="Passkey name"
					bind:value={passkeyName}
					style="max-width:240px;"
				/>
				<input
					class="input"
					type="password"
					placeholder="Current password"
					autocomplete="current-password"
					aria-label="Current password"
					bind:value={passkeyPassword}
					style="max-width:240px;"
				/>
				<button
					type="button"
					class="btn btn-primary"
					disabled={passkeyBusy || !passkeyPassword}
					onclick={addPasskey}
				>
					{passkeyBusy ? 'Waiting for your device...' : 'Add passkey'}
				</button>
			</div>
		{/if}
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Sessions</h2>
		<p class="admin-block-sub">Devices currently signed in to your account.</p>
	</div>
	<div class="admin-card tight">
		<div class="attn-list">
			{#each data.sessions as session (session.id)}
				<div class="user-row">
					<div class="user-row-avatar" style="background:var(--bg-inset);color:var(--text-muted);">
						<svg
							width="18"
							height="18"
							viewBox="0 0 20 20"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							><rect x="3" y="4" width="14" height="10" rx="1" /><line
								x1="6"
								y1="17"
								x2="14"
								y2="17"
							/><line x1="10" y1="14" x2="10" y2="17" /></svg
						>
					</div>
					<div class="user-row-identity">
						<p class="user-row-name">{session.userAgent ?? 'Unknown device'}</p>
						<p class="user-row-email">Last active {formatDateTime(session.lastSeenAt)}</p>
					</div>
					<div class="user-row-actions">
						{#if session.current}
							<span class="pill pill-accent">Current</span>
						{:else}
							<form method="POST" action="?/revokeSession">
								<input type="hidden" name="sessionId" value={session.id} />
								<button type="submit" class="btn btn-ghost btn-sm">Revoke</button>
							</form>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
	{#if data.sessions.length > 1}
		<div class="settings-actions">
			{#if form?.scope === 'sessions' && form.saved}
				<span class="field-hint" role="status" style="color:var(--status-final);">Done.</span>
			{/if}
			<form method="POST" action="?/revokeOthers">
				<button type="submit" class="btn btn-danger">Sign out all other sessions</button>
			</form>
		</div>
	{/if}
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Your data</h2>
		<p class="admin-block-sub">
			Download everything you have written - every universe, story, scene, and worldbuilding entry,
			with relationships, story notes, review feedback, and your images - as a folder of markdown
			files.
		</p>
	</div>
	<div class="admin-card">
		<ExportPanel
			scope="account"
			formats={[{ format: 'zip', label: 'everything (.zip)' }]}
			exports={data.exports}
			assetsConfigured={data.assetsConfigured}
		/>
	</div>
</div>

<div class="admin-block">
	<div class="settings-group danger-group">
		<header class="settings-group-header">
			<h2 class="settings-group-title">Delete account</h2>
			<p class="settings-group-subtitle">
				This deletes your account and everything you have written. Your public pages come down
				straight away, and after {data.graceDays} days everything is removed for good. We email you a
				link to cancel if you change your mind. Download your work above first if you want a copy.
			</p>
		</header>
		<form method="POST" action="?/deleteAccount">
			<div class="field">
				<label for="delete-password">Confirm your password to continue</label>
				<input
					id="delete-password"
					class="input"
					type="password"
					name="password"
					required
					autocomplete="current-password"
				/>
			</div>
			<div class="settings-actions">
				{#if form?.scope === 'delete' && form.message}
					<span class="field-hint" role="alert" style="color:var(--danger);">{form.message}</span>
				{/if}
				<button type="submit" class="btn btn-danger">Delete my account</button>
			</div>
		</form>
	</div>
</div>
