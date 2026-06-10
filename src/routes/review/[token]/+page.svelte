<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import ReviewWorkspace from '$lib/components/ReviewWorkspace.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title
		>{data.state === 'review' || data.state === 'join' ? data.storyTitle : 'Review'} - Codex</title
	>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if data.state === 'review'}
	<div class="app">
		<header class="topbar">
			<span class="brand">
				<span class="brand-mark" style="color: #fff"><Icon name="feather" size={15} /></span>
				<span class="brand-name">Codex</span>
			</span>
			<div class="review-guest-bar">
				<span class="rg-title">{data.storyTitle}</span>
				<span class="rg-who">Reviewing as {data.reviewerName}</span>
			</div>
		</header>
		{#if form?.message}<p class="review-error" role="alert">{form.message}</p>{/if}
		<ReviewWorkspace
			chapters={data.chapters}
			scenes={data.scenes}
			threads={data.threads}
			suggestions={data.suggestions}
			role="guest"
			canSuggest={data.canSuggest}
			entities={data.mentionEntities}
			mentionMembers={data.mentionMembers}
			mentionPins={data.mentionPins}
		/>
	</div>
{:else}
	<main class="review-note">
		{#if data.state === 'unknown'}
			<h1>This link does not work</h1>
			<p>Check that the whole link was copied, or ask the author to send a new one.</p>
		{:else if data.state === 'revoked'}
			<h1>This review has ended</h1>
			<p>The author has closed this review link.</p>
		{:else if data.state === 'expired'}
			<h1>This link has expired</h1>
			<p>Ask the author to send a new one.</p>
		{:else if data.state === 'join'}
			<h1>You are invited to review "{data.storyTitle}"</h1>
			<p>Enter a name so the author knows who the comments are from. No account is needed.</p>
			<form method="POST" action="?/join">
				{#if form?.message}<p class="note-error" role="alert">{form.message}</p>{/if}
				<input
					type="text"
					name="displayName"
					placeholder="Your name"
					aria-label="Your name"
					required
				/>
				<input
					type="email"
					name="email"
					placeholder="Email (optional)"
					aria-label="Email (optional)"
				/>
				<p class="join-hint">
					Leave an email to hear when the author replies to your comments. Every message has a link
					to stop them.
				</p>
				<button class="join-go" type="submit">Start reviewing</button>
			</form>
		{/if}
	</main>
{/if}

<style>
	.review-note {
		max-width: 30rem;
		margin: 8vh auto 0;
		padding: 28px 30px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.review-note h1 {
		font-family: var(--font-serif);
		font-size: 26px;
		font-weight: 600;
		margin: 0 0 12px;
	}
	.review-note p {
		color: var(--text-muted);
		font-size: 14px;
		line-height: 1.6;
		margin: 0 0 12px;
	}
	.review-note form {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 16px;
	}
	.review-note input {
		height: 38px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg);
		padding: 0 12px;
		font: inherit;
		font-size: 14px;
		color: var(--text);
	}
	.review-note input:focus {
		outline: none;
		border-color: var(--accent-line);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	.join-hint {
		font-size: 12px;
		margin: 0;
	}
	.join-go {
		align-self: flex-start;
		border: 0;
		background: var(--accent);
		color: var(--accent-contrast);
		font-weight: 600;
		font-size: 14px;
		padding: 9px 18px;
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.note-error {
		color: var(--danger);
	}
	.review-error {
		position: fixed;
		top: 60px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		margin: 0;
		padding: 8px 16px;
		background: var(--danger-soft);
		color: var(--danger);
		border: 1px solid color-mix(in oklab, var(--danger) 40%, transparent);
		border-radius: var(--radius-md);
		font-size: 13px;
		box-shadow: var(--shadow);
	}
</style>
