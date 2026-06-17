<script lang="ts">
	import { resolve } from '$app/paths';
	import HelpLink from '$lib/components/HelpLink.svelte';
	import { startBackgroundReview } from '$lib/assistant-actions';
	import { REVIEW_CATEGORIES } from '$lib/review-shape';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function inviteStatus(invitation: PageData['reviewInvitations'][number]): string {
		if (invitation.revokedAt) return 'Revoked';
		if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) return 'Expired';
		return 'Active';
	}

	let copiedReviewLink = $state(false);
	function copyReviewLink(path: string) {
		navigator.clipboard.writeText(`${location.origin}${path}`).then(() => {
			copiedReviewLink = true;
			setTimeout(() => (copiedReviewLink = false), 1500);
		});
	}

	// Queues a whole-story Assistant review (a background job) and tracks it in
	// the activity center; the owner is also notified when its notes land on the
	// review page. The story-level button runs the full copyedit: every scene
	// swept category by category, then one cross-scene consistency pass.
	let requestingReview = $state(false);
	async function reviewWholeStory() {
		if (requestingReview) return;
		requestingReview = true;
		try {
			await startBackgroundReview({
				storyId: data.story.id,
				categories: [...REVIEW_CATEGORIES],
				label: 'your story',
				reviewHref: `/stories/${data.story.slug}/review`
			});
		} finally {
			requestingReview = false;
		}
	}
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">
		Review <HelpLink topic="reviewing" label="reviewing" />
	</h2>
	<p class="admin-block-sub">
		Invite someone to read this story and leave comments. They follow a link; no account is needed.
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (app path with a suffix) -->
		<a href={`${resolve('/stories/[id]', { id: data.story.slug })}/review`}> Open review mode</a> to read
		the manuscript and leave your own comments and suggestions, and to work through any feedback.
	</p>
</div>
{#if data.assistant.surfacesEnabled}
	<div class="settings-group">
		<p class="admin-block-sub" style="margin-top:0;">
			The Assistant can read the whole story and leave its own comments and suggested edits,
			alongside any from your reviewers. It runs in the background; you will be notified when its
			notes are ready on the review page.
		</p>
		<button
			type="button"
			class="btn btn-primary"
			onclick={reviewWholeStory}
			disabled={requestingReview}
		>
			{requestingReview ? 'Starting...' : 'Review this story with the Assistant'}
		</button>
	</div>
{/if}
<div class="settings-group">
	<form method="POST" action="?/createReviewInvite">
		{#if form?.action === 'review' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		<div class="field-grid">
			<div class="field">
				<label for="st-review-note">Who is this link for? (optional)</label>
				<input
					id="st-review-note"
					class="input"
					type="text"
					name="note"
					placeholder="e.g. Sam, my writing group"
				/>
			</div>
			<div class="field">
				<label for="st-review-expiry">Expires after (days)</label>
				<input
					id="st-review-expiry"
					class="input"
					type="number"
					name="expiresDays"
					min="1"
					max="365"
					placeholder="Never"
				/>
			</div>
		</div>
		<div class="field">
			<label class="check-row">
				<input type="checkbox" name="canSuggest" checked />
				Allow suggested edits (you accept or reject each one; comments are always allowed)
			</label>
		</div>
		<div class="settings-actions">
			<button class="btn btn-primary" type="submit">Create review link</button>
		</div>
	</form>
	{#if form?.action === 'review' && 'reviewLink' in form && form.reviewLink}
		<p role="status" class="review-link">
			Share this link; it is shown only once:
			<code>{form.reviewLink}</code>
			<button class="btn" type="button" onclick={() => copyReviewLink(form.reviewLink as string)}>
				{copiedReviewLink ? 'Copied' : 'Copy link'}
			</button>
		</p>
	{/if}
	{#if data.reviewInvitations.length > 0}
		<ul class="invitations">
			{#each data.reviewInvitations as invitation (invitation.id)}
				<li>
					<span>
						{invitation.email ?? 'Review link'} - {inviteStatus(invitation)}, created {new Date(
							invitation.createdAt
						).toLocaleDateString()}{invitation.guests.length > 0
							? ` - joined: ${invitation.guests.map((guest) => guest.displayName).join(', ')}`
							: ''}
					</span>
					{#if inviteStatus(invitation) === 'Active'}
						<form method="POST" action="?/revokeReviewInvite">
							<input type="hidden" name="invitationId" value={invitation.id} />
							<button type="submit" class="danger-ghost">Revoke</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.review-link {
		font-size: 13.5px;
	}
	.review-link code {
		word-break: break-all;
	}
	.invitations {
		list-style: none;
		padding: 0;
		margin: 10px 0 0;
		font-size: 13.5px;
	}
	.invitations li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
		border-top: 1px dashed var(--border);
	}
	.invitations form {
		margin-left: auto;
	}
	.danger-ghost {
		background: transparent;
		border: 0;
		color: var(--danger, #b00020);
		cursor: pointer;
		padding: 0;
		font-size: 12.5px;
	}
</style>
