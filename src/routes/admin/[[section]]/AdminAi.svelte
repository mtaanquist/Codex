<script lang="ts">
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Instance</p>
	<h1 class="admin-title">AI</h1>
	<p class="admin-lede">
		Each writer connects their own model endpoint for the Assistant. This setting controls which
		network addresses this server is allowed to reach on their behalf.
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
