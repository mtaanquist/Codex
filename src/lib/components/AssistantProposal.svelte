<script lang="ts" module>
	// A scene split the Assistant proposed; rendered as a card with a confirm
	// button, plus the client-side confirm state the panel mutates in place.
	export type SplitProposal = {
		sceneId: string;
		sceneTitle: string | null;
		before: string;
		rationale: string;
		// Set once the split landed; the card shows it as done and offers the
		// revert. Persisted with the turn, so it survives a reload.
		confirmed?: { splitSceneId: string; newSceneId: string };
		confirming?: boolean;
		reverting?: boolean;
		error?: string;
	};
</script>

<script lang="ts">
	import Icon from './Icon.svelte';

	// eslint-disable-next-line svelte/no-unused-props -- the card shows the cohesive proposal; the panel reads sceneId off the same object for the split call
	let {
		proposal,
		onConfirm,
		onRevert
	}: {
		proposal: SplitProposal;
		// Omitted when splitting is not available (no scene editor open).
		onConfirm?: () => void;
		// Omitted when reverting is not available.
		onRevert?: () => void;
	} = $props();
</script>

<div class="proposal">
	<div class="proposal-head">
		<Icon name="split" size={13} />
		Split {proposal.sceneTitle ? `"${proposal.sceneTitle}"` : 'this scene'}
	</div>
	{#if proposal.rationale}
		<p class="proposal-why">{proposal.rationale}</p>
	{/if}
	<div class="proposal-quote">{proposal.before}</div>
	<div class="proposal-actions">
		{#if proposal.confirmed}
			<button class="btn btn-primary" type="button" disabled>
				<Icon name="check" size={12} /> Split
			</button>
			{#if onRevert}
				<button class="btn" type="button" disabled={proposal.reverting} onclick={onRevert}>
					{proposal.reverting ? 'Merging back...' : 'Revert'}
				</button>
			{/if}
			<span class="proposal-hint">Revert merges the two scenes back into one.</span>
		{:else}
			{#if onConfirm}
				<button
					class="btn btn-primary"
					type="button"
					disabled={proposal.confirming}
					onclick={onConfirm}
				>
					{proposal.confirming ? 'Splitting...' : 'Split here'}
				</button>
			{/if}
			<span class="proposal-hint">The new scene starts at the quoted text.</span>
		{/if}
	</div>
	{#if proposal.error}
		<p class="proposal-error" role="alert">{proposal.error}</p>
	{/if}
</div>

<style>
	.proposal {
		margin-top: 8px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-card);
		padding: 10px 12px;
		font-size: 13px;
	}
	.proposal-head {
		display: flex;
		align-items: center;
		gap: 7px;
		font-weight: 600;
		color: var(--text);
	}
	.proposal-why {
		margin: 6px 0 0;
		color: var(--text-muted);
	}
	.proposal-quote {
		margin-top: 8px;
		border-left: 3px solid var(--accent);
		padding-left: 8px;
		color: var(--text-muted);
		font-size: 12.5px;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.proposal-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}
	.proposal-hint {
		font-size: 12px;
		color: var(--text-faint);
	}
	.proposal-error {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--danger, #c0392b);
	}
</style>
