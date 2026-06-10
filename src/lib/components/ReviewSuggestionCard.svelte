<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import ReviewAvatar from './ReviewAvatar.svelte';
	import {
		authorColor,
		suggestionAuthor,
		suggestionKind,
		type ReviewSuggestion,
		type ReviewThread
	} from '$lib/review-ui';

	let {
		suggestion,
		discussion = null,
		role,
		focused,
		onFocus,
		onAccepted = null,
		assistant = null,
		onAssistantReply = null
	}: {
		suggestion: ReviewSuggestion;
		// The suggestion's discussion thread, once someone has replied on it.
		discussion?: ReviewThread | null;
		role: 'author' | 'guest';
		focused: boolean;
		// Clicking the card jumps to and pulses its passage in the manuscript.
		onFocus: (id: string) => void;
		// Called with the suggestion id the moment the server confirms an
		// accept, before the page data reloads, so the author's live editor can
		// apply the change at once.
		onAccepted?: ((ids: string[]) => void) | null;
		// Set when the Assistant answers replies on its suggestions (author
		// page, Assistant live); carries its display name for the waiting note.
		assistant?: { name: string } | null;
		onAssistantReply?: ((threadId: string) => Promise<void>) | null;
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

	// The discussion on this suggestion: every comment of its lazily created
	// thread (it has no opening comment of its own).
	const replies = $derived(discussion?.comments ?? []);
	let replyText = $state('');

	// The Assistant answers replies on its own pending suggestions; the thread
	// id comes back from the reply action that created or found the thread.
	let assistantBusy = $state(false);
	const assistantAnswers = $derived(
		Boolean(assistant && onAssistantReply && suggestion.isAssistant && pending)
	);

	async function triggerAssistant(threadId: string) {
		if (!onAssistantReply || assistantBusy) return;
		assistantBusy = true;
		try {
			await onAssistantReply(threadId);
		} finally {
			assistantBusy = false;
		}
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
					<form
						method="POST"
						action="?/acceptSuggestion"
						use:enhance={() =>
							async ({ result, update }) => {
								if (result.type === 'success') onAccepted?.([suggestion.id]);
								await update();
							}}
					>
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

	{#if replies.length > 0}
		<div class="rv-replies">
			{#each replies as reply (reply.id)}
				<div class="rv-reply-row">
					<ReviewAvatar
						author={{
							isOwner: reply.isOwner,
							isAssistant: reply.isAssistant,
							name: reply.authorName
						}}
						size={20}
					/>
					<div class="rv-reply-main">
						<div class="rv-reply-head">
							<span class="rv-reply-name">{reply.authorName}</span>
							<span class="rv-reply-when">{when(reply.createdAt)}</span>
						</div>
						<div class="rv-reply-body">{reply.body}</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="rv-card-foot" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
		{#if pending}
			{#if assistantBusy && assistant}
				<div class="rv-assistant-wait">
					<Icon name="sparkles" size={12} />
					{assistant.name} is replying...
				</div>
			{/if}
			<form
				method="POST"
				action="?/replySuggestion"
				class="rv-reply"
				use:enhance={() =>
					async ({ result, update }) => {
						replyText = '';
						await update({ reset: false });
						// The author replied on the Assistant's suggestion; it answers
						// in the thread the action just created or found.
						const threadId =
							result.type === 'success' && typeof result.data?.threadId === 'string'
								? result.data.threadId
								: null;
						if (assistantAnswers && threadId) void triggerAssistant(threadId);
					}}
			>
				<input type="hidden" name="suggestionId" value={suggestion.id} />
				<input
					type="text"
					name="body"
					placeholder="Reply..."
					aria-label="Reply"
					bind:value={replyText}
					required
				/>
				<button
					class="rv-reply-send"
					type="submit"
					disabled={!replyText.trim()}
					aria-label="Send reply"
				>
					<Icon name="reply" size={15} />
				</button>
			</form>
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
