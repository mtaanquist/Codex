<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { confirmSubmit } from '#lib/confirm.svelte';
	import { DRAFT_LABEL_MAX, DRAFT_NOTE_MAX } from '#lib/drafts';
	import { formatDateTime, formatNumber } from '#lib/format';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import HelpLink from '#lib/components/HelpLink.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The draft whose rename form is open.
	let editing = $state<string | null>(null);

	function draftHref(id: string) {
		return resolve('/stories/[id]/drafts/[draft=uuid]', { id: data.story.slug, draft: id });
	}
	const drafts = $derived(form?.action === 'drafts' ? form : null);
	const savedId = $derived(drafts && 'savedDraftId' in drafts ? drafts.savedDraftId : null);
	const formSuccess = $derived(
		!drafts
			? null
			: 'deleted' in drafts
				? 'Draft deleted.'
				: 'saved' in drafts
					? 'Draft renamed.'
					: null
	);
	const rowError = $derived(
		drafts && 'draftId' in drafts && 'message' in drafts ? drafts.draftId : null
	);
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">
		Saved drafts <HelpLink topic="drafts" label="saved drafts" />
	</h2>
	<p class="admin-block-sub">
		Save the whole story as it is now, so you can always go back to it. A saved draft keeps the
		scenes, chapters, notes, and the universe's characters, places, and lore exactly as they are,
		and never changes after you save it.
	</p>
	<p class="admin-block-sub">
		Review comments and suggestions are not saved with a draft. To start a fresh round of feedback,
		use "Clear review notes..." in review mode.
	</p>
</div>
<div class="settings-group">
	<form method="POST" action="?/saveDraft" id="save-draft">
		<div class="field">
			<label for="draft-label">Name</label>
			<input
				id="draft-label"
				class="input"
				name="label"
				required
				maxlength={DRAFT_LABEL_MAX}
				placeholder="First draft"
			/>
		</div>
		<div class="field">
			<label for="draft-note">Note (optional)</label>
			<textarea
				id="draft-note"
				class="textarea"
				name="note"
				rows="2"
				maxlength={DRAFT_NOTE_MAX}
				placeholder="What this draft is, or what changed"></textarea>
		</div>
		<FormStatus
			error={drafts && 'message' in drafts && !rowError ? drafts.message : null}
			success={formSuccess}
			block
		/>
		{#if savedId}
			<p class="field-hint saved" role="status">
				Draft saved. <a href={draftHref(savedId)}>Open it</a>
			</p>
		{/if}
		<div class="settings-actions">
			<button class="btn btn-primary" type="submit">Save draft</button>
		</div>
	</form>

	{#if data.drafts.length > 0}
		<ul class="draft-list">
			{#each data.drafts as draft (draft.id)}
				<li class="draft-row">
					<div class="draft-row-main">
						<a class="draft-row-title" href={draftHref(draft.id)}>{draft.label}</a>
						<span class="draft-row-meta">
							{formatDateTime(draft.createdAt, page.data.timeZone)} - {formatNumber(
								draft.wordCount
							)} words
						</span>
						{#if draft.noteMd}<p class="draft-row-note">{draft.noteMd}</p>{/if}
					</div>
					<div class="draft-row-actions">
						<button
							class="btn btn-sm btn-ghost"
							type="button"
							aria-expanded={editing === draft.id}
							onclick={() => (editing = editing === draft.id ? null : draft.id)}
						>
							Rename
						</button>
						<form
							method="POST"
							action="?/deleteDraft"
							onsubmit={confirmSubmit({
								title: `Delete "${draft.label}"?`,
								body: 'The saved copy is deleted for good. Your working draft is not affected.',
								confirmLabel: 'Delete draft',
								danger: true
							})}
						>
							<input type="hidden" name="draftId" value={draft.id} />
							<button class="btn btn-sm btn-danger" type="submit">Delete</button>
						</form>
					</div>
					{#if editing === draft.id || rowError === draft.id}
						<form class="draft-edit" method="POST" action="?/updateDraft">
							<input type="hidden" name="draftId" value={draft.id} />
							<div class="field">
								<label for="draft-label-{draft.id}">Name</label>
								<input
									id="draft-label-{draft.id}"
									class="input"
									name="label"
									required
									maxlength={DRAFT_LABEL_MAX}
									value={draft.label}
								/>
							</div>
							<div class="field">
								<label for="draft-note-{draft.id}">Note</label>
								<textarea
									id="draft-note-{draft.id}"
									class="textarea"
									name="note"
									rows="2"
									maxlength={DRAFT_NOTE_MAX}>{draft.noteMd ?? ''}</textarea
								>
							</div>
							<FormStatus
								error={rowError === draft.id && drafts && 'message' in drafts
									? drafts.message
									: null}
								block
							/>
							<div class="settings-actions">
								<button class="btn btn-primary btn-sm" type="submit">Save</button>
							</div>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="field-hint">Drafts you save show up here, newest first.</p>
	{/if}
</div>

<style>
	.saved {
		color: var(--status-final-ink);
	}
	.draft-list {
		list-style: none;
		padding: 0;
		margin: var(--space-6) 0 0;
		border-top: 1px solid var(--border);
	}
	.draft-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		padding: var(--space-3) 0;
		border-bottom: 1px solid var(--border);
	}
	.draft-row-main {
		flex: 1;
		min-width: 12rem;
	}
	.draft-row-title {
		font-weight: 650;
		color: var(--text);
	}
	.draft-row-meta {
		display: block;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.draft-row-note {
		margin: var(--space-1) 0 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
		white-space: pre-wrap;
	}
	.draft-row-actions {
		display: flex;
		align-items: flex-start;
		gap: var(--space-1);
	}
	.draft-edit {
		flex-basis: 100%;
	}
</style>
