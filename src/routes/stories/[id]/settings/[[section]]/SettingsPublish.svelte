<script lang="ts">
	import HelpLink from '$lib/components/HelpLink.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const FORMAT_LABELS: Record<string, string> = {
		markdown: 'Markdown (.zip)',
		epub: 'EPUB',
		pdf: 'PDF'
	};

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">
		Publish <HelpLink topic="publishing" label="publishing" />
	</h2>
	<p class="admin-block-sub">Who can find this story, and the frozen editions readers see.</p>
</div>
<div class="settings-group">
	<form method="POST" action="?/setVisibility">
		{#if form?.action === 'publish' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'publish' && 'saved' in form && form.saved}
			<p class="field-hint" role="status" style="color:var(--status-final);">Saved.</p>
		{/if}
		<div class="field">
			<label for="st-visibility">Visibility</label>
			<select id="st-visibility" class="select" name="visibility" value={data.story.visibility}>
				<option value="private">Private - not on your public pages</option>
				<option value="unlisted">Unlisted - direct link only</option>
				<option value="public">Public - listed on your shelf</option>
			</select>
		</div>
		<div class="field">
			<label class="check-row">
				<input type="checkbox" name="isAdult" checked={data.story.isAdult} />
				Adult content
			</label>
		</div>
		<div class="settings-actions">
			<button class="btn btn-primary" type="submit">Save visibility</button>
		</div>
	</form>
	<form method="POST" action="?/publish">
		{#if form?.action === 'publish' && 'published' in form && form.published}
			<p class="field-hint" role="status" style="color:var(--status-final);">
				Edition published. Readers see it at
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (public reader path) -->
				<a href="/@{data.archive.handle}/{data.story.id}">
					/@{data.archive.handle}/{data.story.id}
				</a>.
			</p>
		{/if}
		<div class="field">
			<label for="st-edition-label">Edition label (optional)</label>
			<input
				id="st-edition-label"
				class="input"
				type="text"
				name="versionLabel"
				placeholder="Edition 2"
			/>
			<p class="field-hint">
				Publishing freezes the story as it stands now. Later edits stay private until you publish
				again.
			</p>
		</div>
		<div class="settings-actions">
			<button class="btn btn-primary" type="submit">Publish edition</button>
		</div>
	</form>

	{#if data.edition && data.assetsConfigured}
		<div class="sub-head">Edition downloads</div>
		{#if form?.action === 'exports' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'exports' && 'queued' in form && form.queued}
			<p class="field-hint" role="status">
				Export run queued. The files appear below in a moment; reload to see them.
			</p>
		{/if}
		{#if form?.action === 'exports' && 'saved' in form && form.saved}
			<p class="field-hint" role="status" style="color:var(--status-final);">Saved.</p>
		{/if}
		{#if data.artifacts.length > 0}
			<ul class="exports">
				{#each data.artifacts as artifact (artifact.id)}
					<li>
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (file download) -->
						<a href="/artifacts/{artifact.id}" download>
							{FORMAT_LABELS[artifact.format] ?? artifact.format}
						</a>
						- {formatBytes(artifact.byteSize)}, generated {new Date(
							artifact.createdAt
						).toLocaleString()}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="field-hint">
				The download files for this edition have not been generated yet. They are created shortly
				after publishing; if they do not appear, run the generation again.
			</p>
		{/if}
		{#if data.edition.artifactErrors.length > 0}
			<p class="field-hint" style="color:var(--danger);">
				Some downloads could not be built on the last run:
				{data.edition.artifactErrors
					.map((e) => `${e.format.toUpperCase()} (${e.error})`)
					.join(', ')}. A PDF needs the headless browser set up on the server; ask an administrator,
				then generate again.
			</p>
		{/if}
		<form method="POST" action="?/regenerateExports">
			<div class="settings-actions">
				<button class="btn" type="submit">Generate again</button>
			</div>
		</form>
		<form method="POST" action="?/setDownloads">
			<div class="field">
				<label class="check-row">
					<input type="checkbox" name="downloadsPublic" checked={data.edition.downloadsPublic} />
					Let readers download this edition (EPUB and PDF) from its public page
				</label>
			</div>
			<div class="settings-actions">
				<button class="btn btn-primary" type="submit">Save</button>
			</div>
		</form>
	{/if}
</div>

<style>
	.sub-head {
		font-size: 12.5px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 18px 0 10px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}
	.exports {
		list-style: none;
		padding: 0;
		margin: 0 0 10px;
		font-size: 13.5px;
	}
	.exports li {
		padding: 5px 0;
		color: var(--text-muted);
	}
	.exports a {
		color: var(--text);
		font-weight: 600;
	}
</style>
