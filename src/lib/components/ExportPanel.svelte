<script lang="ts">
	type ExportItem = {
		id: string;
		format: 'zip' | 'epub';
		status: 'pending' | 'ready' | 'failed';
		filename: string | null;
		error: string | null;
		createdAt: string | Date;
	};

	let {
		scope,
		targetId = null,
		formats,
		exports,
		assetsConfigured
	}: {
		scope: 'account' | 'story' | 'universe';
		targetId?: string | null;
		formats: { format: 'zip' | 'epub'; label: string }[];
		exports: ExportItem[];
		assetsConfigured: boolean;
	} = $props();

	function when(date: string | Date): string {
		return new Date(date).toLocaleString(undefined, {
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

{#if !assetsConfigured}
	<p class="field-hint">
		Exports need image storage set up on this instance. Ask an administrator to configure it.
	</p>
{:else}
	<p class="field-hint">
		Preparing an export runs in the background. It appears below when it is ready; reload the page
		to check.
	</p>
	<div class="export-actions">
		{#each formats as choice (choice.format)}
			<form method="POST" action="?/requestExport">
				<input type="hidden" name="scope" value={scope} />
				{#if targetId}<input type="hidden" name="targetId" value={targetId} />{/if}
				<input type="hidden" name="format" value={choice.format} />
				<button type="submit" class="btn btn-secondary">Prepare {choice.label}</button>
			</form>
		{/each}
	</div>

	{#if exports.length > 0}
		<ul class="export-list">
			{#each exports as item (item.id)}
				<li class="export-row">
					<span class="export-name">{item.filename ?? `${item.format.toUpperCase()} export`}</span>
					<span class="export-meta">{when(item.createdAt)}</span>
					{#if item.status === 'ready'}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (file download) -->
						<a class="btn btn-ghost btn-sm" href="/exports/{item.id}" download>Download</a>
					{:else if item.status === 'pending'}
						<span class="export-status">Preparing...</span>
					{:else}
						<span class="export-status export-failed" title={item.error ?? ''}>Failed</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<style>
	.export-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.75rem 0;
	}
	.export-list {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.export-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.4rem 0;
		border-top: 1px solid var(--border);
	}
	.export-name {
		font-weight: 500;
	}
	.export-meta {
		color: var(--text-muted);
		font-size: 0.85em;
		margin-right: auto;
	}
	.export-status {
		color: var(--text-muted);
		font-size: 0.9em;
	}
	.export-failed {
		color: var(--danger);
	}
</style>
