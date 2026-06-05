<script lang="ts">
	import { reviewSegments } from '$lib/review-segments';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Thread = (PageData & { state: 'review' })['threads'][number];

	const scenes = $derived(data.state === 'review' ? data.scenes : []);
	const threads = $derived(data.state === 'review' ? data.threads : []);
	const suggestions = $derived(data.state === 'review' ? data.suggestions : []);
	const canSuggest = $derived(data.state === 'review' && data.canSuggest);

	function chapterScenes(chapterId: string | null) {
		return scenes.filter((scene) => scene.chapterId === chapterId);
	}
	function sceneThreads(sceneId: string): Thread[] {
		return threads.filter((thread) => thread.sceneId === sceneId);
	}
	function sceneSuggestions(sceneId: string) {
		return suggestions.filter((suggestion) => suggestion.sceneId === sceneId);
	}

	// The manuscript renders as text nodes and highlight marks; a scene's
	// threads with live anchors slice it into segments.
	function segments(scene: { id: string; bodyMd: string }) {
		return reviewSegments(scene.bodyMd, sceneThreads(scene.id));
	}

	// Maps a DOM selection inside a manuscript container back to character
	// offsets in the scene's text by walking its text nodes in order.
	function textOffset(container: Node, target: Node, offset: number): number {
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		let total = 0;
		let node = walker.nextNode();
		while (node) {
			if (node === target) return total + offset;
			total += node.textContent?.length ?? 0;
			node = walker.nextNode();
		}
		return total;
	}

	let manuscriptEls: Record<string, HTMLElement> = {};
	let pending = $state<{
		sceneId: string;
		start: number;
		end: number;
		excerpt: string;
		selectedText: string;
		mode: 'comment' | 'suggest';
	} | null>(null);
	// Whole-scene comment form target; mutually exclusive with a selection.
	let commentingScene = $state<string | null>(null);

	function captureSelection(sceneId: string) {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;
		const container = manuscriptEls[sceneId];
		const range = selection.getRangeAt(0);
		if (
			!container ||
			!container.contains(range.startContainer) ||
			!container.contains(range.endContainer)
		) {
			return;
		}
		const start = textOffset(container, range.startContainer, range.startOffset);
		const end = textOffset(container, range.endContainer, range.endOffset);
		if (end <= start) return;
		const scene = scenes.find((entry) => entry.id === sceneId);
		const selectedText = scene ? scene.bodyMd.slice(start, end) : '';
		pending = {
			sceneId,
			start,
			end,
			excerpt: selectedText.slice(0, 120),
			selectedText,
			mode: 'comment'
		};
		commentingScene = null;
	}

	function when(date: Date | string): string {
		return new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	function scrollToThread(threadId: string | null) {
		if (!threadId) return;
		document.getElementById(`thread-${threadId}`)?.scrollIntoView({ block: 'center' });
	}
</script>

<svelte:head>
	<title
		>{data.state === 'review' || data.state === 'join' ? data.storyTitle : 'Review'} - Codex</title
	>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if data.state === 'unknown'}
	<main class="review note-page">
		<h1>This link does not work</h1>
		<p>Check that the whole link was copied, or ask the author to send a new one.</p>
	</main>
{:else if data.state === 'revoked'}
	<main class="review note-page">
		<h1>This review has ended</h1>
		<p>The author has closed this review link.</p>
	</main>
{:else if data.state === 'expired'}
	<main class="review note-page">
		<h1>This link has expired</h1>
		<p>Ask the author to send a new one.</p>
	</main>
{:else if data.state === 'join'}
	<main class="review note-page">
		<h1>You are invited to review "{data.storyTitle}"</h1>
		<p>Enter a name so the author knows who the comments are from. No account is needed.</p>
		<form method="POST" action="?/join">
			{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
			<input
				type="text"
				name="displayName"
				placeholder="Your name"
				aria-label="Your name"
				required
			/>
			<button type="submit">Start reviewing</button>
		</form>
	</main>
{:else if data.state === 'review'}
	<main class="review">
		<header>
			<h1>{data.storyTitle}</h1>
			<p class="byline">
				Reviewing as {data.reviewerName}. Select any passage to comment on it{data.canSuggest
					? ' or to suggest a change to it'
					: ''}, or comment on a whole scene. The author sees everything you leave here and can
				reply.
			</p>
			{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
		</header>

		{#each data.chapters as chapter, chapterIndex (chapter.id)}
			{#if chapterScenes(chapter.id).length > 0}
				<section class="chapter">
					<h2>{chapter.title ?? `Chapter ${chapterIndex + 1}`}</h2>
					{#each chapterScenes(chapter.id) as scene (scene.id)}
						{@render sceneBlock(scene)}
					{/each}
				</section>
			{/if}
		{/each}
		{#if chapterScenes(null).length > 0}
			<section class="chapter">
				<h2>Unfiled scenes</h2>
				{#each chapterScenes(null) as scene (scene.id)}
					{@render sceneBlock(scene)}
				{/each}
			</section>
		{/if}
	</main>
{/if}

{#snippet sceneBlock(scene: {
	id: string;
	chapterId: string | null;
	title: string | null;
	bodyMd: string;
})}
	<article class="scene">
		{#if scene.title}<h3>{scene.title}</h3>{/if}
		<div
			class="manuscript"
			role="presentation"
			bind:this={manuscriptEls[scene.id]}
			onmouseup={() => captureSelection(scene.id)}
		>
			{#each segments(scene) as part, i (i)}
				{#if part.threadId}<button
						type="button"
						class="mk"
						onclick={() => scrollToThread(part.threadId)}>{part.text}</button
					>{:else}{part.text}{/if}
			{/each}
		</div>

		{#if pending?.sceneId === scene.id}
			<form
				method="POST"
				action={pending.mode === 'suggest' ? '?/suggest' : '?/comment'}
				class="comment-box"
			>
				<p class="excerpt">On: "{pending.excerpt}{pending.excerpt.length >= 120 ? '...' : ''}"</p>
				{#if canSuggest}
					<div class="row mode-row">
						<button
							type="button"
							class:ghost={pending.mode !== 'comment'}
							onclick={() => (pending = pending && { ...pending, mode: 'comment' })}
						>
							Comment
						</button>
						<button
							type="button"
							class:ghost={pending.mode !== 'suggest'}
							onclick={() => (pending = pending && { ...pending, mode: 'suggest' })}
						>
							Suggest a change
						</button>
					</div>
				{/if}
				<input type="hidden" name="sceneId" value={scene.id} />
				<input type="hidden" name="start" value={pending.start} />
				<input type="hidden" name="end" value={pending.end} />
				{#if pending.mode === 'suggest'}
					<p class="excerpt">Edit the text below; the author can accept or reject the change.</p>
					<textarea name="replacement" rows="3" aria-label="Suggested text"
						>{pending.selectedText}</textarea
					>
				{:else}
					<textarea name="body" rows="3" placeholder="Your comment" required></textarea>
				{/if}
				<div class="row">
					<button type="submit">
						{pending.mode === 'suggest' ? 'Suggest' : 'Comment'}
					</button>
					<button type="button" class="ghost" onclick={() => (pending = null)}>Cancel</button>
				</div>
			</form>
		{:else if commentingScene === scene.id}
			<form method="POST" action="?/comment" class="comment-box">
				<input type="hidden" name="sceneId" value={scene.id} />
				<textarea name="body" rows="3" placeholder="Your comment on this scene" required></textarea>
				<div class="row">
					<button type="submit">Comment</button>
					<button type="button" class="ghost" onclick={() => (commentingScene = null)}>
						Cancel
					</button>
				</div>
			</form>
		{:else}
			<button
				type="button"
				class="ghost scene-comment"
				onclick={() => {
					commentingScene = scene.id;
					pending = null;
				}}
			>
				Comment on this scene
			</button>
		{/if}

		{#each sceneThreads(scene.id) as thread (thread.id)}
			<div class="thread" id="thread-{thread.id}" class:resolved={thread.resolvedAt}>
				{#if thread.resolvedAt}<p class="badge">Resolved</p>{/if}
				{#if thread.anchorLost}
					<p class="badge lost">The text this comment pointed at has changed.</p>
				{/if}
				{#each thread.comments as comment (comment.id)}
					<div class="comment" class:owner={comment.isOwner}>
						<p class="who">{comment.authorName} - {when(comment.createdAt)}</p>
						<p class="what">{comment.body}</p>
					</div>
				{/each}
				{#if !thread.resolvedAt}
					<form method="POST" action="?/reply" class="reply">
						<input type="hidden" name="threadId" value={thread.id} />
						<input type="text" name="body" placeholder="Reply" aria-label="Reply" required />
						<button type="submit">Reply</button>
					</form>
				{/if}
			</div>
		{/each}

		{#each sceneSuggestions(scene.id) as suggestion (suggestion.id)}
			<div class="thread suggestion" class:resolved={suggestion.status !== 'pending'}>
				<p class="who">
					{suggestion.reviewerName} suggested - {when(suggestion.createdAt)}
					{#if suggestion.status === 'accepted'}<span class="badge">Accepted</span>
					{:else if suggestion.status === 'rejected'}<span class="badge lost">Rejected</span>
					{:else if suggestion.anchorLost}
						<span class="badge lost">The text has changed since</span>
					{/if}
				</p>
				{#if suggestion.original}<p class="what"><del>{suggestion.original}</del></p>{/if}
				{#if suggestion.replacement}<p class="what"><ins>{suggestion.replacement}</ins></p>{/if}
			</div>
		{/each}
	</article>
{/snippet}

<style>
	.review {
		max-width: 44rem;
		margin: 0 auto;
		padding: 3rem 1rem 5rem;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 1.05rem;
		line-height: 1.7;
		color: #1a1a1a;
		background: #fff;
	}
	.note-page {
		font-family: system-ui, sans-serif;
		padding-top: 6rem;
	}
	.note-page form {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.note-page input {
		flex: 1;
		padding: 0.5rem;
	}
	header {
		margin-bottom: 3rem;
	}
	.byline {
		color: #555;
		font-family: system-ui, sans-serif;
		font-size: 0.9rem;
	}
	.chapter h2 {
		text-align: center;
		font-size: 1.3rem;
		margin: 3rem 0 1.5rem;
	}
	.scene {
		margin-bottom: 2.5rem;
	}
	.scene h3 {
		font-family: system-ui, sans-serif;
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #777;
	}
	.manuscript {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	/* A highlighted passage doubles as the jump to its thread. Styled as a
	   highlight, not a button, so the prose keeps flowing. */
	.manuscript .mk {
		display: inline;
		font: inherit;
		color: inherit;
		white-space: inherit;
		padding: 0;
		border: 0;
		border-bottom: 2px solid #f0c000;
		border-radius: 0;
		background: #fff3bf;
		cursor: pointer;
	}
	.comment-box,
	.thread {
		font-family: system-ui, sans-serif;
		font-size: 0.9rem;
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 0.75rem;
		margin-top: 0.75rem;
	}
	.comment-box textarea,
	.reply input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.4rem;
		font: inherit;
	}
	.comment-box .row {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.excerpt {
		color: #777;
		font-style: italic;
		margin: 0 0 0.5rem;
	}
	.thread.resolved {
		opacity: 0.65;
	}
	.badge {
		display: inline-block;
		font-size: 0.75rem;
		font-weight: 600;
		color: #2b7a2b;
		margin: 0 0 0.5rem;
	}
	.badge.lost {
		color: #a05a00;
	}
	.comment {
		margin-bottom: 0.5rem;
	}
	.comment.owner .who {
		color: #1a4a8a;
	}
	.who {
		font-weight: 600;
		font-size: 0.8rem;
		margin: 0;
	}
	.what {
		margin: 0.15rem 0 0;
		white-space: pre-wrap;
	}
	.reply {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.scene-comment {
		margin-top: 0.5rem;
	}
	.mode-row {
		margin-bottom: 0.5rem;
	}
	.suggestion del {
		background: #ffe3e3;
		text-decoration: line-through;
	}
	.suggestion ins {
		background: #d3f9d8;
		text-decoration: none;
	}
	.suggestion .what {
		font-family: Georgia, 'Times New Roman', serif;
	}
	button {
		font-family: system-ui, sans-serif;
		padding: 0.4rem 0.9rem;
		border: 1px solid #1a4a8a;
		background: #1a4a8a;
		color: #fff;
		border-radius: 6px;
		cursor: pointer;
	}
	button.ghost {
		background: transparent;
		color: #1a4a8a;
	}
	.error {
		color: #b00020;
		font-family: system-ui, sans-serif;
	}
</style>
