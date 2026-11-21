<script lang="ts">
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit, autosubmitForm } from '#lib/autosave-form';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Instance</p>
	<h1 class="admin-title">AI</h1>
	<p class="admin-lede">
		Each writer connects their own model endpoint for the Assistant. The first setting controls
		which network addresses this server is allowed to reach on their behalf; the second, whether
		writers may connect an AI app of their own to their account.
	</p>
</div>

<div class="admin-block">
	<div class="admin-card">
		<form method="POST" action="?/saveEgress">
			{#if form?.scope === 'egress' && form.message}
				<div
					class="status-banner"
					style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
				>
					<span class="x">{form.message}</span>
				</div>
			{:else if form?.scope === 'egress' && form.saved}
				<div class="status-banner ok">
					<span class="dot"></span><span class="v">Saved.</span>
				</div>
			{/if}

			<div class="field">
				<label for="egress-policy">Outbound connections</label>
				<select id="egress-policy" class="select" name="policy">
					<option value="block-private" selected={data.egress.policy === 'block-private'}>
						Block private addresses (recommended for shared instances)
					</option>
					<option value="allowlist" selected={data.egress.policy === 'allowlist'}>
						Only allow the hosts listed below
					</option>
					<option value="open" selected={data.egress.policy === 'open'}>
						Allow any address (single-operator instances)
					</option>
				</select>
				<span class="field-hint">
					"Block private addresses" lets writers reach public endpoints while keeping the server
					away from internal addresses. Choose "Allow any address" only when you run this instance
					for yourself and need to reach a local model.
				</span>
			</div>

			<div class="field" style="margin-bottom:0;">
				<label for="egress-allowlist">Allowed hosts</label>
				<textarea
					id="egress-allowlist"
					class="textarea"
					name="allowlist"
					rows="4"
					placeholder="ollama.internal&#10;api.example.com"
					>{data.egress.allowlist.join('\n')}</textarea
				>
				<span class="field-hint">
					One host per line. Used only when "Only allow the hosts listed below" is selected.
				</span>
			</div>

			<div class="settings-actions">
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Access for other apps</h2>
		<p class="admin-block-sub">
			Writers can connect an AI app of their own to read their writing and leave suggestions. Each
			writer has to turn this on for their own account first.
		</p>
	</div>
	<div class="admin-card">
		<form
			method="POST"
			action="?/saveExternalAccess"
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<div class="toggle-row">
				<label class="toggle">
					<input
						type="checkbox"
						name="enabled"
						aria-label="Allow writers to connect other apps"
						checked={data.externalAccess}
					/>
					<span class="toggle-track"></span>
				</label>
				<div style="flex:1;">
					<div class="t-title">Allow writers to connect other apps</div>
					<div class="t-sub">
						When this is off, no app can connect to this instance, apps already connected stop
						working, and writers do not see the setting.
					</div>
				</div>
			</div>
			<div class="settings-actions">
				<FormStatus success={form?.scope === 'external-access' && form.saved ? 'Saved.' : null} />
			</div>
		</form>
	</div>
</div>
