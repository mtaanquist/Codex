<script lang="ts">
	import { diffLines } from 'diff';
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';

	// The centre column while a past revision is open: banner, the
	// revision's text (read-only), and a toggle that diffs it against what
	// is live now. Restore swaps the live text and stacks a new revision.
	let {
		revision,
		currentBody,
		entityType,
		entityId,
		exitHref
	}: {
		revision: {
			id: string;
			label: string | null;
			createdAt: Date;
			bodyMd: string;
		};
		currentBody: string;
		entityType: string;
		entityId: string;
		exitHref: string;
	} = $props();

	let showDiff = $state(false);
	let restoring = $state(false);

	const parts = $derived(showDiff ? diffLines(currentBody, revision.bodyMd) : []);
	const paragraphs = $derived(revision.bodyMd.split(/\n\n+/).filter((part) => part.trim() !== ''));

	async function restore() {
		restoring = true;
		const response = await fetch(`/api/revisions/${revision.id}/restore`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ entityType, entityId })
		});
		restoring = false;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		if (response.ok) await goto(exitHref, { invalidateAll: true });
	}
</script>

<div class="revision-banner">
	<div class="revision-banner-icon"><Icon name="clock" size={16} /></div>
	<div class="revision-banner-main">
		<div class="revision-banner-title">Viewing a past revision</div>
		<div class="revision-banner-sub">
			{revision.createdAt.toLocaleString()}{revision.label ? ` - ${revision.label}` : ''}
		</div>
	</div>
	<div class="revision-banner-actions">
		<button class="rb-btn ghost" type="button" onclick={() => (showDiff = !showDiff)}>
			{showDiff ? 'Show text' : 'Show changes'}
		</button>
		<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
		<a class="rb-btn ghost" href={exitHref}>Exit preview</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		<button class="rb-btn solid" type="button" disabled={restoring} onclick={restore}>
			Restore this version
		</button>
	</div>
</div>

{#if showDiff}
	<div class="prose-historical diff-view">
		{#each parts as part, index (index)}<span
				class:diff-add={part.added}
				class:diff-del={part.removed}>{part.value}</span
			>{/each}
	</div>
{:else}
	<div class="prose-historical">
		{#each paragraphs as paragraph, index (index)}
			<p>{paragraph}</p>
		{/each}
		{#if paragraphs.length === 0}
			<p class="empty-body">This revision is empty.</p>
		{/if}
	</div>
{/if}

<style>
	.diff-view {
		white-space: pre-wrap;
		line-height: 1.7;
	}
	.diff-add {
		background: color-mix(in oklab, var(--cat-green, #3a7d44) 22%, transparent);
		border-radius: 3px;
	}
	.diff-del {
		background: color-mix(in oklab, var(--danger, #b00020) 18%, transparent);
		text-decoration: line-through;
		border-radius: 3px;
	}
	.rb-btn {
		text-decoration: none;
		cursor: pointer;
	}
	.empty-body {
		color: var(--text-faint);
		font-style: italic;
	}
</style>
