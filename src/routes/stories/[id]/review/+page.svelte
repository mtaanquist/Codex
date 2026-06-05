<script lang="ts">
	import { resolve } from '$app/paths';
	import { reviewSegments } from '$lib/review-segments';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Only scenes with feedback render here; the author reads the full prose
	// in the editor, this page is for working through the threads.
	const scenesWithThreads = $derived(
		data.scenes.filter(
			(scene) =>
				data.threads.some((thread) => thread.sceneId === scene.id) ||
				data.suggestions.some((suggestion) => suggestion.sceneId === scene.id)
		)
	);
	const openCount = $derived(data.threads.filter((thread) => !thread.resolvedAt).length);
	const pendingSuggestions = $derived(
		data.suggestions.filter((suggestion) => suggestion.status === 'pending').length
	);

	function sceneThreads(sceneId: string) {
		return data.threads.filter((thread) => thread.sceneId === sceneId);
	}
	function sceneSuggestions(sceneId: string) {
		return data.suggestions.filter((suggestion) => suggestion.sceneId === sceneId);
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
	<title>{data.story.title} - Review feedback - Codex</title>
</svelte:head>

<main class="feedback">
	<nav>
		<a href={resolve('/')}>Library</a> /
		<a href={resolve('/stories/[id]', { id: data.story.slug })}>{data.story.title}</a> /
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (app path with a suffix) -->
		<a href={`${resolve('/stories/[id]', { id: data.story.slug })}/settings`}>Settings</a>
	</nav>
	<h1>Review feedback</h1>
	<p class="lede">
		{#if data.threads.length === 0 && data.suggestions.length === 0}
			No feedback yet. Invite a reviewer from the story settings; their comments and suggested
			changes appear here.
		{:else}
			{openCount} open {openCount === 1 ? 'thread' : 'threads'}{pendingSuggestions > 0
				? ` and ${pendingSuggestions} suggested ${pendingSuggestions === 1 ? 'change' : 'changes'} waiting`
				: ''}. Reply, resolve, accept, or reject below; everything decided stays for the record.
		{/if}
	</p>
	{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}

	{#each scenesWithThreads as scene (scene.id)}
		<section class="scene">
			<h2>{scene.title ?? 'Untitled scene'}</h2>
			<div class="manuscript">
				{#each reviewSegments(scene.bodyMd, sceneThreads(scene.id)) as part, i (i)}
					{#if part.threadId}<button
							type="button"
							class="mk"
							onclick={() => scrollToThread(part.threadId)}>{part.text}</button
						>{:else}{part.text}{/if}
				{/each}
			</div>

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
							<span class="badge lost">
								The text has changed since; this can only be rejected.
							</span>
						{/if}
					</p>
					{#if suggestion.original}<p class="what prose"><del>{suggestion.original}</del></p>{/if}
					{#if suggestion.replacement}
						<p class="what prose"><ins>{suggestion.replacement}</ins></p>
					{/if}
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
	{/each}
</main>

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
	.scene {
		margin: 2.5rem 0;
	}
	.scene h2 {
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
