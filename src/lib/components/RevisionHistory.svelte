<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	type Row = { id: string; reason: string | null; label: string | null; createdAt: Date };

	// The History tab: the open item's timeline, newest first, with a
	// checkpoint form on top. Previewing happens in the centre column; the
	// rows only link there.
	let {
		entityType,
		entityId,
		revisions = [],
		previewId,
		previewHref
	}: {
		entityType: string;
		entityId: string;
		revisions?: Row[];
		previewId?: string;
		// Builds the link that opens a revision in the centre column.
		previewHref: (revisionId: string) => string;
	} = $props();

	let label = $state('');
	let saving = $state(false);

	const DOT: Record<string, string> = { checkpoint: 'checkpoint', restore: 'import' };
	const TITLE: Record<string, string> = {
		checkpoint: 'Checkpoint',
		restore: 'Restored',
		autosave: 'Autosave'
	};

	function rowTitle(row: Row) {
		return row.label || TITLE[row.reason ?? 'autosave'] || 'Autosave';
	}

	function when(date: Date) {
		const delta = Date.now() - date.getTime();
		if (delta < 60_000) return 'just now';
		if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
		if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
		return date.toLocaleDateString();
	}

	async function checkpoint(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		const response = await fetch('/api/revisions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ entityType, entityId, label })
		});
		saving = false;
		if (response.ok) {
			label = '';
			await invalidateAll();
		}
	}
</script>

<div class="right-scroll">
	<form class="cp-form" onsubmit={checkpoint}>
		<input
			type="text"
			placeholder="Checkpoint name (optional)"
			bind:value={label}
			aria-label="Checkpoint name"
		/>
		<button class="mini-btn solid" type="submit" disabled={saving}>Checkpoint now</button>
	</form>
	<div class="hist-list">
		{#each revisions as row (row.id)}
			<div class="hist-row" class:previewing={row.id === previewId}>
				<span class="revision-dot revision-dot-{DOT[row.reason ?? ''] ?? 'autosave'}"></span>
				<div class="hist-main">
					<div class="hist-label">{rowTitle(row)}</div>
					<div class="hist-meta">
						<span>{when(row.createdAt)}</span>
						{#if row.label && row.reason !== 'checkpoint'}
							<span class="hist-note">{row.label}</span>
						{/if}
					</div>
					{#if row.id !== previewId}
						<div class="hist-actions">
							<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
							<a class="mini-btn" href={previewHref(row.id)}>Preview</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
	<div class="hist-foot">
		{revisions.length === 0
			? 'Saved versions appear here as you write.'
			: 'Select a revision to preview it in the editor.'}
	</div>
</div>

<style>
	.cp-form {
		display: flex;
		gap: 6px;
		padding: 2px 0 10px;
	}
	.cp-form input {
		flex: 1;
		min-width: 0;
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		color: var(--text);
		font-size: 12.5px;
		padding: 5px 8px;
		outline: none;
	}
	.cp-form input:focus {
		border-color: var(--accent-line);
	}
	.cp-form input::placeholder {
		color: var(--text-faint);
	}
	.mini-btn {
		text-decoration: none;
		cursor: pointer;
	}
</style>
