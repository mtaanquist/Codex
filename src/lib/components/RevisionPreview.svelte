<script lang="ts">
	import { diffLines } from 'diff';
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import type { EntitySnapshot } from '$lib/entity-snapshot';

	// The centre column while a past revision is open: banner, the
	// revision's text (read-only), and a toggle that diffs it against what
	// is live now. Entity revisions also carry a snapshot of the structured
	// fields, shown above the text. Restore swaps the live content and
	// stacks a new revision.
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
			snapshot?: EntitySnapshot | null;
		};
		currentBody: string;
		entityType: string;
		entityId: string;
		exitHref: string;
	} = $props();

	const snapshot = $derived(revision.snapshot ?? null);
	const snapshotTags = $derived(snapshot?.aliases ?? snapshot?.keywords ?? []);

	let showDiff = $state(false);
	let restoring = $state(false);

	const parts = $derived(showDiff ? diffLines(currentBody, revision.bodyMd) : []);
	const paragraphs = $derived(revision.bodyMd.split(/\n\n+/).filter((part) => part.trim() !== ''));

	async function restore() {
		restoring = true;
		// A network-level rejection must not leave the button stuck disabled.
		try {
			const response = await fetch(`/api/revisions/${revision.id}/restore`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ entityType, entityId })
			});
			if (response.ok) {
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
				await goto(exitHref, { invalidateAll: true });
			} else {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				alert(body?.message ?? 'Could not restore this revision.');
			}
		} catch {
			alert('Could not restore this revision.');
		} finally {
			restoring = false;
		}
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

{#if snapshot}
	<div class="snap">
		<div class="snap-row">
			<span class="snap-k">Name</span>
			<span class="snap-v">{snapshot.name}</span>
		</div>
		{#if snapshotTags.length > 0}
			<div class="snap-row">
				<span class="snap-k">{snapshot.aliases ? 'Aliases' : 'Keywords'}</span>
				<span class="snap-v">{snapshotTags.join(', ')}</span>
			</div>
		{/if}
		{#if snapshot.categoryName}
			<div class="snap-row">
				<span class="snap-k">Category</span>
				<span class="snap-v">{snapshot.categoryName}</span>
			</div>
		{/if}
		{#if snapshot.summaryMd}
			<div class="snap-row">
				<span class="snap-k">Summary</span>
				<span class="snap-v">{snapshot.summaryMd}</span>
			</div>
		{/if}
		{#each snapshot.details as detail, index (index)}
			<div class="snap-row">
				<span class="snap-k">{detail.label}</span>
				<span class="snap-v">{detail.value}</span>
			</div>
		{/each}
		{#each snapshot.relationships as relationship, index (index)}
			<div class="snap-row">
				<span class="snap-k">{relationship.label || 'Related'}</span>
				<span class="snap-v">
					{relationship.otherName}{relationship.notesMd ? ` - ${relationship.notesMd}` : ''}
				</span>
			</div>
		{/each}
	</div>
{/if}

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
	.snap {
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		padding: 10px 14px;
		margin-bottom: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.snap-row {
		display: flex;
		gap: 10px;
		font-size: 13px;
		line-height: 1.5;
	}
	.snap-k {
		flex: 0 0 110px;
		font-size: 11px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		padding-top: 2px;
	}
	.snap-v {
		color: var(--text);
		min-width: 0;
	}
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
