<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { formatDate } from '$lib/format';
	import S3Fields from './S3Fields.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const lastBackup = $derived(data.backupRuns[0] ?? null);
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Data</p>
	<h1 class="admin-title">Backups</h1>
	<p class="admin-lede">
		Off-site database snapshots taken by the worker.
		{#if data.backupStorage.source === 'environment'}
			Currently taking values from the environment; saving here overrides them.
		{:else if data.backupStorage.source === 'none'}
			Not configured yet; until a bucket is set below, no snapshots are taken.
		{/if}
	</p>
</div>

{#if form?.scope === 'backups' && form.message}
	<div
		class="status-banner"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">{form.message}</span>
	</div>
{:else if form?.scope === 'backups' && form.saved}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v">Saved.</span>
	</div>
{:else if form?.scope === 'backups' && form.tested}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v">The bucket is reachable and writable.</span>
	</div>
{:else if form?.scope === 'backups' && form.done}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v">Backup queued. Refresh to see the result.</span>
	</div>
{/if}

{#if data.backupsConfigured}
	<div class="admin-block">
		<div class="status-banner ok">
			<span class="dot"></span>
			<span>
				<span class="v">Backups are on</span>
				{#if lastBackup}<span class="x"
						>- last run {lastBackup.status} on {formatDate(lastBackup.startedAt)}</span
					>{/if}
			</span>
			<span class="when">
				<form method="POST" action="?/runBackup">
					<button type="submit" class="btn btn-primary btn-sm">Back up now</button>
				</form>
			</span>
		</div>
	</div>
{/if}

{#if !data.secretsAvailable}
	<div
		class="status-banner"
		style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
	>
		<span class="x">
			Set APP_SECRET on the server to store a secret key here. Without it you can still seed backups
			from environment variables.
		</span>
	</div>
{/if}

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">Storage</h2>
			<p class="admin-block-sub">
				Any S3-compatible bucket works: S3, Backblaze B2, MinIO, R2. Use a different bucket than the
				one holding uploaded images.
			</p>
		</div>
	</div>
	<div class="admin-card">
		<form method="POST" action="?/saveBackups">
			<S3Fields idPrefix="backup" view={data.backupStorage} />
			<div class="field-grid">
				<div class="field">
					<label for="backup-keep-hours">Keep every dump for (hours)</label>
					<input
						id="backup-keep-hours"
						class="input"
						type="number"
						name="keepRecentHours"
						min="1"
						value={data.backupStorage.keepRecentHours}
					/>
				</div>
				<div class="field">
					<label for="backup-keep-days">Keep one dump per day for (days)</label>
					<input
						id="backup-keep-days"
						class="input"
						type="number"
						name="keepDays"
						min="1"
						value={data.backupStorage.keepDays}
					/>
				</div>
			</div>
			<div class="settings-actions">
				<button type="submit" formaction="?/testBackups" class="btn btn-ghost">
					Test connection
				</button>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</div>
</div>

{#if data.backupRuns.length > 0}
	<div class="admin-block">
		<div class="admin-block-head">
			<h2 class="admin-block-title">Recent runs</h2>
		</div>
		<div class="admin-card tight">
			<div class="attn-list">
				{#each data.backupRuns as run (run.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								{run.status}
								<span class="pill">{run.trigger}</span>
							</div>
							<div class="list-sub">
								{run.sizeBytes ? `${(run.sizeBytes / 1024).toFixed(0)} KB` : 'no size'}{run.error
									? ` - ${run.error}`
									: ''}
							</div>
						</div>
						<div class="list-sub">{formatDate(run.startedAt)}</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
