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
	// The author works an open suggestion straight from the card corner.
	const canDecide = $derived(role === 'author' && pending);

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
	class="rv-card sugg"
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
		{#if canDecide}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="rv-quick" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
				{#if !suggestion.anchorLost}
					<form method="POST" action="?/acceptSuggestion" use:enhance>
						<input type="hidden" name="suggestionId" value={suggestion.id} />
						<button
							class="rv-quick-btn accept"
							type="submit"
							title="Accept suggestion"
							aria-label="Accept suggestion"
						>
							<Icon name="check" size={15} />
						</button>
					</form>
				{/if}
				<form method="POST" action="?/rejectSuggestion" use:enhance>
					<input type="hidden" name="suggestionId" value={suggestion.id} />
					<button
						class="rv-quick-btn reject"
						type="submit"
						title="Reject suggestion"
						aria-label="Reject suggestion"
					>
						<Icon name="close" size={15} />
					</button>
				</form>
			</div>
		{:else}
			<span class="rv-type-pill sugg"><Icon name="suggest" size={11} /> {verb}</span>
		{/if}
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

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="rv-card-foot" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
		{#if pending}
			{#if suggestion.mine}
				<div class="rv-actions">
					<form method="POST" action="?/deleteSuggestion" use:enhance onsubmit={confirmRetract}>
						<input type="hidden" name="suggestionId" value={suggestion.id} />
						<button
							class="rv-btn ghost danger"
							type="submit"
							aria-label="Delete your suggested edit"
						>
							<Icon name="trash" size={14} /> Delete
						</button>
					</form>
				</div>
			{:else if role === 'guest'}
				<div class="rv-actions">
					<span class="rv-status resolved">Waiting on the author</span>
				</div>
			{/if}
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
