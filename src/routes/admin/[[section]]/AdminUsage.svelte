<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { formatDate } from '$lib/format';
	import S3Fields from './S3Fields.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Data</p>
	<h1 class="admin-title">Usage &amp; storage</h1>
	<p class="admin-lede">
		Where uploaded images and stored export files are kept.
		{#if data.assetStorage.source === 'environment'}
			Currently taking values from the environment; saving here overrides them.
		{:else if data.assetStorage.source === 'none'}
			Not configured yet; until a bucket is set below, image uploads are off.
		{/if}
	</p>
</div>

{#if form?.scope === 'storage' && form.message}
	<div
		class="status-banner"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">{form.message}</span>
	</div>
{:else if form?.scope === 'storage' && form.saved}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v">Saved.</span>
	</div>
{:else if form?.scope === 'storage' && form.tested}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v">The bucket is reachable and writable.</span>
	</div>
{:else if form?.scope === 'storage' && form.migrating}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v"
			>Copy started. The worker copies every stored file; check back here for the result.</span
		>
	</div>
{/if}

{#if data.assetMigrationPending}
	<div
		class="status-banner"
		style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
	>
		<span class="x">
			Files uploaded before the storage change are still in the old location. Copy them to the new
			storage, or dismiss this if you moved them yourself.
		</span>
		<span class="when" style="display:flex;gap:8px;">
			<form method="POST" action="?/migrateAssets">
				<button type="submit" class="btn btn-primary btn-sm">Copy files</button>
			</form>
			<form method="POST" action="?/dismissMigration">
				<button type="submit" class="btn btn-ghost btn-sm">Dismiss</button>
			</form>
		</span>
	</div>
{/if}

{#if data.assetMigration}
	<p class="admin-block-sub">
		Last copy finished {formatDate(data.assetMigration.finishedAt)}: {data.assetMigration.copied} copied,
		{data.assetMigration.failed} failed{data.assetMigration.failed > 0
			? '. Failures are listed in the worker log; run the copy again to retry.'
			: '.'}
	</p>
{/if}

{#if !data.secretsAvailable}
	<div
		class="status-banner"
		style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
	>
		<span class="x">
			Set APP_SECRET on the server to store a secret key here. Without it you can still seed asset
			storage from environment variables.
		</span>
	</div>
{/if}

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">Asset storage</h2>
			<p class="admin-block-sub">
				Any S3-compatible bucket works: S3, Backblaze B2, MinIO, R2. Use a different bucket than the
				one holding backups, so a database restore keeps every image link valid.
			</p>
		</div>
	</div>
	<div class="admin-card">
		<form method="POST" action="?/saveAssets">
			<S3Fields idPrefix="asset" view={data.assetStorage} />
			<div class="settings-actions">
				<button type="submit" formaction="?/testAssets" class="btn btn-ghost">
					Test connection
				</button>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="admin-card">
		<p class="admin-block-sub" style="margin:0;">
			Per-writer usage and a storage breakdown will come in a later release.
		</p>
	</div>
</div>
