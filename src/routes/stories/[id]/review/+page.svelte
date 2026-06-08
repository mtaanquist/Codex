<script lang="ts">
	import { resolve } from '$app/paths';
	import { reviewSegments } from '$lib/review-segments';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The author's own review pass: read the whole manuscript, leave comments
	// and suggested edits like a reviewer would, and work through everything
	// guests have left - reply, resolve, accept, reject.
	const openCount = $derived(data.threads.filter((thread) => !thread.resolvedAt).length);
	const pendingSuggestions = $derived(
		data.suggestions.filter((suggestion) => suggestion.status === 'pending').length
	);

	function chapterScenes(chapterId: string | null) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}
	function sceneThreads(sceneId: string) {
		return data.threads.filter((thread) => thread.sceneId === sceneId);
	}
	function sceneSuggestions(sceneId: string) {
		return data.suggestions.filter((suggestion) => suggestion.sceneId === sceneId);
	}
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
		const scene = data.scenes.find((entry) => entry.id === sceneId);
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
	<title>{data.story.title} - Review - Codex</title>
</svelte:head>

<main class="feedback">
	<nav>
		<a href={resolve('/')}>Library</a> /
		<a href={resolve('/stories/[id]', { id: data.story.slug })}>{data.story.title}</a> /
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (app path with a suffix) -->
		<a href={`${resolve('/stories/[id]', { id: data.story.slug })}/settings`}>Settings</a>
	</nav>
	<h1>Review</h1>
	<p class="lede">
		Select any passage to comment on it or suggest a change, or comment on a whole scene. Anything
		you leave is visible to reviewers you have invited.
		{#if openCount > 0 || pendingSuggestions > 0}
			{openCount} open {openCount === 1 ? 'thread' : 'threads'}{pendingSuggestions > 0
				? ` and ${pendingSuggestions} suggested ${pendingSuggestions === 1 ? 'change' : 'changes'} waiting`
				: ''}.
		{/if}
	</p>
	{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}

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

{#snippet sceneBlock(scene: {
	id: string;
	chapterId: string | null;
	title: string | null;
	bodyMd: string;
})}
	<section class="scene">
		<h3>{scene.title ?? 'Untitled scene'}</h3>
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
				<input type="hidden" name="sceneId" value={scene.id} />
				<input type="hidden" name="start" value={pending.start} />
				<input type="hidden" name="end" value={pending.end} />
				{#if pending.mode === 'suggest'}
					<p class="excerpt">Edit the text below; you (or a reviewer) can accept or reject it.</p>
					<textarea name="replacement" rows="3" aria-label="Suggested text"
						>{pending.selectedText}</textarea
					>
				{:else}
					<textarea name="body" rows="3" placeholder="Your comment" required></textarea>
				{/if}
				<div class="row">
					<button type="submit">{pending.mode === 'suggest' ? 'Suggest' : 'Comment'}</button>
					<button type="button" class="ghost" onclick={() => (pending = null)}>Cancel</button>
				</div>
			</form>
		{:else if commentingScene === scene.id}
			<form method="POST" action="?/comment" class="comment-box">
				<input type="hidden" name="sceneId" value={scene.id} />
				<textarea name="body" rows="3" placeholder="Your comment on this scene" required></textarea>
				<div class="row">
					<button type="submit">Comment</button>
					<button type="button" class="ghost" onclick={() => (commentingScene = null)}
						>Cancel</button
					>
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
				{:else if !thread.anchor}
					<p class="badge scene-wide">On the whole scene</p>
				{/if}
				{#each thread.comments as comment (comment.id)}
					<div class="comment" class:owner={comment.isOwner}>
						<p class="who">{comment.authorName} - {when(comment.createdAt)}</p>
						<p class="what">{comment.body}</p>
					</div>
				{/each}
				<div class="actions">
					{#if !thread.resolvedAt}
						<form method="POST" action="?/reply" class="reply">
							<input type="hidden" name="threadId" value={thread.id} />
							<input type="text" name="body" placeholder="Reply" aria-label="Reply" required />
							<button type="submit">Reply</button>
						</form>
						<form method="POST" action="?/resolve">
							<input type="hidden" name="threadId" value={thread.id} />
							<button type="submit" class="ghost">Resolve</button>
						</form>
					{:else}
						<form method="POST" action="?/reopen">
							<input type="hidden" name="threadId" value={thread.id} />
							<button type="submit" class="ghost">Reopen</button>
						</form>
					{/if}
				</div>
			</div>
		{/each}

		{#each sceneSuggestions(scene.id) as suggestion (suggestion.id)}
			<div class="thread suggestion" class:resolved={suggestion.status !== 'pending'}>
				<p class="who">
					{suggestion.reviewerName} suggests - {when(suggestion.createdAt)}
					{#if suggestion.status === 'accepted'}<span class="badge">Accepted</span>
					{:else if suggestion.status === 'rejected'}<span class="badge lost">Rejected</span>
					{:else if suggestion.anchorLost}
						<span class="badge lost">The text has changed since; this can only be rejected.</span>
					{/if}
				</p>
				{#if suggestion.original}<p class="what prose"><del>{suggestion.original}</del></p>{/if}
				{#if suggestion.replacement}<p class="what prose">
						<ins>{suggestion.replacement}</ins>
					</p>{/if}
				{#if suggestion.status === 'pending'}
					<div class="actions">
						{#if !suggestion.anchorLost}
							<form method="POST" action="?/acceptSuggestion">
								<input type="hidden" name="suggestionId" value={suggestion.id} />
								<button type="submit">Accept</button>
							</form>
						{/if}
						<form method="POST" action="?/rejectSuggestion">
							<input type="hidden" name="suggestionId" value={suggestion.id} />
							<button type="submit" class="ghost">Reject</button>
						</form>
					</div>
				{/if}
			</div>
		{/each}
	</section>
{/snippet}

<style>
	.feedback {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1rem 5rem;
		font-family: system-ui, sans-serif;
	}
	nav {
		font-size: 0.85rem;
		margin-bottom: 1rem;
	}
	.lede {
		color: #555;
	}
	.chapter h2 {
		text-align: center;
		font-size: 1.2rem;
		margin: 2.5rem 0 1.25rem;
		font-family: Georgia, 'Times New Roman', serif;
	}
	.scene {
		margin: 2rem 0;
	}
	.scene h3 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #777;
	}
	.manuscript {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 1.02rem;
		line-height: 1.7;
		border: 1px solid #eee;
		border-radius: 8px;
		padding: 1rem;
	}
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
	.comment-box {
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 0.75rem;
		margin-top: 0.75rem;
		font-size: 0.9rem;
	}
	.comment-box textarea {
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
	.mode-row {
		margin-bottom: 0.5rem;
	}
	.excerpt {
		color: #777;
		font-style: italic;
		margin: 0 0 0.5rem;
	}
	.scene-comment {
		margin-top: 0.5rem;
	}
	.thread {
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 0.75rem;
		margin-top: 0.75rem;
		font-size: 0.9rem;
	}
	.thread.resolved {
		opacity: 0.65;
	}
	.badge {
		display: inline-block;
		font-size: 0.75rem;
		font-weight: 600;
		color: #2b7a2b;
		margin: 0 0.5rem 0.5rem 0;
	}
	.badge.lost {
		color: #a05a00;
	}
	.badge.scene-wide {
		color: #555;
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
	.actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.reply {
		display: flex;
		gap: 0.5rem;
		flex: 1;
	}
	.reply input {
		flex: 1;
		padding: 0.4rem;
		font: inherit;
	}
	button {
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
	}
	.suggestion .prose {
		font-family: Georgia, 'Times New Roman', serif;
	}
	.suggestion del {
		background: #ffe3e3;
		text-decoration: line-through;
	}
	.suggestion ins {
		background: #d3f9d8;
		text-decoration: none;
	}
</style>
