<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import ReviewAvatar from './ReviewAvatar.svelte';
	import {
		authorColor,
		suggestionAuthor,
		suggestionKind,
		type ReviewSuggestion
	} from '$lib/review-ui';

	let {
		suggestion,
		role,
		focused,
		onFocus
	}: {
		suggestion: ReviewSuggestion;
		role: 'author' | 'guest';
		focused: boolean;
		// Clicking the card jumps to and pulses its passage in the manuscript.
		onFocus: (id: string) => void;
	} = $props();

	const author = $derived(suggestionAuthor(suggestion));
	const color = $derived(authorColor(author));
	const kind = $derived(suggestionKind(suggestion));
	const verb = $derived(kind === 'insert' ? 'Insert' : kind === 'delete' ? 'Delete' : 'Replace');
	const roleLabel = $derived(
		author.isAssistant ? 'Assistant' : author.isOwner ? 'Author' : 'Reviewer'
	);
	const pending = $derived(suggestion.status === 'pending');

	function when(date: Date | string): string {
		return new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	function confirmRetract(e: SubmitEvent) {
		if (!confirm('Delete your suggested edit? This cannot be undone.')) e.preventDefault();
	}
</script>

<!-- The card jumps to its passage in the manuscript; the label keeps its
     accessible name off the action buttons inside it. -->
<div
	id="rv-card-{suggestion.id}"
	class="rv-card"
	class:is-focused={focused}
	style="--auth: {color};"
	role="button"
	tabindex="0"
	aria-label="Go to this suggestion in the manuscript"
	onclick={() => onFocus(suggestion.id)}
	onkeydown={(e) => {
		if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			onFocus(suggestion.id);
		}
	}}
>
	<div class="rv-card-top">
		<ReviewAvatar {author} />
		<div class="rv-who">
			<div class="rv-who-name">
				{suggestion.reviewerName} <span class="rv-role">{roleLabel}</span>
			</div>
			<div class="rv-when">{when(suggestion.createdAt)}</div>
		</div>
		<span class="rv-type-pill"><Icon name="suggest" size={11} /> {verb}</span>
	</div>

	<div class="rv-diff">
		{#if suggestion.original}<span class="rv-diff-del">{suggestion.original}</span>{/if}
		{#if suggestion.replacement}<span class="rv-diff-ins">{suggestion.replacement}</span>{/if}
	</div>

	{#if pending && suggestion.anchorLost}
		<div class="rv-anchor-lost">
			<Icon name="close" size={12} /> The text changed since; this can only be rejected.
		</div>
	{/if}

	<div class="rv-card-foot">
		{#if pending}
			<div class="rv-actions">
				{#if role === 'author'}
					{#if !suggestion.anchorLost}
						<form method="POST" action="?/acceptSuggestion" use:enhance>
							<input type="hidden" name="suggestionId" value={suggestion.id} />
							<button class="rv-btn accept" type="submit">
								<Icon name="check" size={14} /> Accept
							</button>
						</form>
					{/if}
					<form method="POST" action="?/rejectSuggestion" use:enhance>
						<input type="hidden" name="suggestionId" value={suggestion.id} />
						<button class="rv-btn ghost" type="submit">
							<Icon name="close" size={14} /> Reject
						</button>
					</form>
				{:else}
					<span class="rv-status resolved">Waiting on the author</span>
				{/if}
				{#if suggestion.mine}
					<form method="POST" action="?/deleteSuggestion" use:enhance onsubmit={confirmRetract}>
						<input type="hidden" name="suggestionId" value={suggestion.id} />
						<button
							class="rv-btn icon danger"
							type="submit"
							title="Delete your suggestion"
							aria-label="Delete your suggestion"
						>
							<Icon name="trash" size={14} />
						</button>
					</form>
				{/if}
			</div>
		{:else}
			<div class="rv-actions">
				{#if suggestion.status === 'accepted'}
					<span class="rv-status accepted"><Icon name="check" size={12} /> Accepted</span>
				{:else}
					<span class="rv-status rejected"><Icon name="close" size={12} /> Rejected</span>
				{/if}
			</div>
		{/if}
	</div>
</div>
