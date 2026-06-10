<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import ReviewAvatar from './ReviewAvatar.svelte';
	import { authorColor, threadAuthor, type ReviewThread } from '$lib/review-ui';

	let {
		thread,
		excerpt,
		role,
		focused,
		onFocus
	}: {
		thread: ReviewThread;
		// The anchored passage, sliced from the live scene text; null for a
		// whole-scene comment or one whose anchor was lost.
		excerpt: string | null;
		role: 'author' | 'guest';
		focused: boolean;
		// Clicking the card jumps to and pulses its passage in the manuscript.
		onFocus: (id: string) => void;
	} = $props();

	const author = $derived(threadAuthor(thread));
	const color = $derived(authorColor(author));
	const root = $derived(thread.comments[0]);
	const replies = $derived(thread.comments.slice(1));
	const open = $derived(thread.resolvedAt === null);
	const roleLabel = $derived(
		author.isAssistant ? 'Assistant' : author.isOwner ? 'Author' : 'Reviewer'
	);
	// The viewer can retract the whole thread only when every comment in it is
	// their own, so a retraction never takes someone else's reply with it.
	const canDeleteThread = $derived(
		thread.comments.length > 0 && thread.comments.every((c) => c.mine)
	);

	let replyText = $state('');

	function when(date: Date | string): string {
		return new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	function confirmRetract(e: SubmitEvent) {
		if (!confirm('Delete your comment? This cannot be undone.')) e.preventDefault();
	}
</script>

<!-- The card jumps to its passage in the manuscript; the label keeps its
     accessible name off the action buttons inside it. -->
<div
	id="rv-card-{thread.id}"
	class="rv-card"
	class:is-focused={focused}
	style="--auth: {color};"
	role="button"
	tabindex="0"
	aria-label="Go to this comment in the manuscript"
	onclick={() => onFocus(thread.id)}
	onkeydown={(e) => {
		// Only when the card itself has focus, so typing in the reply field is
		// untouched.
		if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			onFocus(thread.id);
		}
	}}
>
	<div class="rv-card-top">
		<ReviewAvatar {author} />
		<div class="rv-who">
			<div class="rv-who-name">{root.authorName} <span class="rv-role">{roleLabel}</span></div>
			<div class="rv-when">{when(root.createdAt)}</div>
		</div>
		{#if open && role === 'author'}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="rv-quick" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
				<form method="POST" action="?/resolve" use:enhance>
					<input type="hidden" name="threadId" value={thread.id} />
					<button
						class="rv-quick-btn resolve"
						type="submit"
						title="Resolve comment"
						aria-label="Resolve comment"
					>
						<Icon name="check" size={15} />
					</button>
				</form>
			</div>
		{:else}
			<span class="rv-type-pill comment"><Icon name="comment" size={11} /> Comment</span>
		{/if}
	</div>

	{#if thread.anchorLost}
		<div class="rv-anchor-lost">
			<Icon name="close" size={12} /> The text this pointed at has changed.
		</div>
	{:else if excerpt}
		<div class="rv-quote">"{excerpt}"</div>
	{:else}
		<div class="rv-scene-wide">On the whole scene</div>
	{/if}

	<div class="rv-body">{root.body}</div>

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
							{#if reply.mine}
								<form
									method="POST"
									action="?/deleteComment"
									class="rv-reply-del"
									use:enhance
									onsubmit={confirmRetract}
								>
									<input type="hidden" name="commentId" value={reply.id} />
									<button type="submit" title="Delete your reply" aria-label="Delete your reply">
										<Icon name="trash" size={12} />
									</button>
								</form>
							{/if}
						</div>
						<div class="rv-reply-body">{reply.body}</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="rv-card-foot" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
		{#if open}
			<form
				method="POST"
				action="?/reply"
				class="rv-reply"
				use:enhance={() =>
					({ update }) => {
						replyText = '';
						return update({ reset: false });
					}}
			>
				<input type="hidden" name="threadId" value={thread.id} />
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
			{#if canDeleteThread}
				<div class="rv-actions">
					<form method="POST" action="?/deleteComment" use:enhance onsubmit={confirmRetract}>
						<input type="hidden" name="commentId" value={root.id} />
						<button class="rv-btn ghost danger" type="submit">
							<Icon name="trash" size={14} /> Delete
						</button>
					</form>
				</div>
			{/if}
		{:else}
			<div class="rv-actions">
				<span class="rv-status resolved"><Icon name="check-circle" size={12} /> Resolved</span>
				{#if role === 'author'}
					<form method="POST" action="?/reopen" use:enhance>
						<input type="hidden" name="threadId" value={thread.id} />
						<button class="rv-btn ghost" type="submit">
							<Icon name="reply" size={14} /> Reopen
						</button>
					</form>
				{/if}
				{#if canDeleteThread}
					<form method="POST" action="?/deleteComment" use:enhance onsubmit={confirmRetract}>
						<input type="hidden" name="commentId" value={root.id} />
						<button class="rv-btn ghost danger" type="submit">
							<Icon name="trash" size={14} /> Delete
						</button>
					</form>
				{/if}
			</div>
		{/if}
	</div>
</div>
