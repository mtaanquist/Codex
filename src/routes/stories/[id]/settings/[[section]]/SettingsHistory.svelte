<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">History</h2>
	<p class="admin-block-sub">Recent changes to this story's scenes and outline.</p>
</div>
<div class="settings-group">
	{#if data.timeline.length === 0}
		<p class="field-hint">Recent changes to this story's scenes and outline appear here.</p>
	{:else}
		<ul class="timeline">
			{#each data.timeline as row (row.id)}
				<li>
					<span class="t-name">{row.entityName ?? 'Untitled'}</span>
					<span class="t-what">
						{row.label ?? (row.reason === 'checkpoint' ? 'checkpoint' : (row.reason ?? 'autosave'))}
					</span>
					<span class="t-when">{row.createdAt.toLocaleString()}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.timeline {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.timeline li {
		display: flex;
		gap: 10px;
		align-items: baseline;
		padding: 6px 0;
		border-bottom: 1px dashed var(--border);
		font-size: 13px;
	}
	.t-name {
		font-weight: 600;
	}
	.t-what {
		color: var(--text-muted);
	}
	.t-when {
		margin-left: auto;
		color: var(--text-faint);
		font-size: 12px;
	}
</style>
