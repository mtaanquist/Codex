<script lang="ts">
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Configuration</p>
	<h1 class="admin-title">Email relay</h1>
	<p class="admin-lede">
		Used to send verification, password-reset, and notification emails.
		{#if data.smtp.source === 'environment'}
			Currently taking values from the environment; saving here overrides them.
		{:else if data.smtp.source === 'none'}
			Not configured yet; until it is, emails are written to the worker log instead of sent.
		{/if}
	</p>
</div>

{#if !data.secretsAvailable}
	<div
		class="status-banner"
		style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
	>
		<span class="x">
			Set APP_SECRET on the server to store a password here. Without it you can still seed SMTP from
			environment variables.
		</span>
	</div>
{/if}

<div class="admin-block">
	<div class="admin-card">
		<form method="POST" action="?/saveSmtp">
			{#if form?.scope === 'smtp' && form.message}
				<div
					class="status-banner"
					style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
				>
					<span class="x">{form.message}</span>
				</div>
			{:else if form?.scope === 'smtp' && form.saved}
				<div class="status-banner ok">
					<span class="dot"></span><span class="v">Saved.</span>
				</div>
			{:else if form?.scope === 'smtp' && form.tested}
				<div class="status-banner ok">
					<span class="dot"></span><span class="v">Test email sent to {form.testTo}.</span>
				</div>
			{/if}

			<div class="field-grid">
				<div class="field">
					<label for="smtp-host">Host</label>
					<input
						id="smtp-host"
						class="input"
						type="text"
						name="host"
						value={data.smtp.host}
						placeholder="smtp.example.com"
					/>
				</div>
				<div class="field">
					<label for="smtp-port">Port</label>
					<input id="smtp-port" class="input" type="number" name="port" value={data.smtp.port} />
				</div>
			</div>

			<div class="toggle-row" style="margin-bottom:var(--space-4);">
				<label class="toggle">
					<input type="checkbox" name="secure" checked={data.smtp.secure} />
					<span class="toggle-track"></span>
				</label>
				<div style="flex:1;">
					<div class="t-title">Use TLS on connect</div>
					<div class="t-sub">
						Turn on if your relay asks for implicit TLS or SSL; leave off if it asks for STARTTLS.
						Go by the relay's instructions, not the port: 465 usually means on and 587 usually off,
						but some relays differ.
					</div>
				</div>
			</div>

			<div class="field">
				<label for="smtp-user">Username</label>
				<input
					id="smtp-user"
					class="input"
					type="text"
					name="user"
					value={data.smtp.user}
					autocomplete="off"
				/>
			</div>
			<div class="field">
				<label for="smtp-password">Password</label>
				<input
					id="smtp-password"
					class="input"
					type="password"
					name="password"
					autocomplete="off"
					placeholder={data.smtp.hasPassword ? 'Leave blank to keep the current password' : ''}
				/>
			</div>
			<div class="field">
				<label for="smtp-from">From address</label>
				<input
					id="smtp-from"
					class="input"
					type="text"
					name="from"
					value={data.smtp.from}
					placeholder="Codex <no-reply@example.com>"
				/>
			</div>
			<div class="field" style="margin-bottom:0;">
				<label for="smtp-test-to">Send the test to</label>
				<input id="smtp-test-to" class="input" type="email" name="testTo" value={data.meEmail} />
				<span class="field-hint">Only used by the test button below.</span>
			</div>

			<div class="settings-actions">
				<button type="submit" formaction="?/testEmail" class="btn btn-ghost">Send test email</button
				>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</div>
</div>
