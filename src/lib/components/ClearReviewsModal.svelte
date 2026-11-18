<script lang="ts">
	import { enhance } from '#lib/enhance';
	import { modal } from '#lib/modal';
	import Icon from './Icon.svelte';

	// Clears the story's review notes in one go: the finished ones, or all of
	// them. Opened from the review page's notes panel, author only.
	let {
		seenAt,
		finished,
		total,
		onClose
	}: {
		// When the counted notes were read; the server keeps anything newer.
		seenAt: string;
		// Resolved comments and decided suggestions in the story.
		finished: number;
		// Every comment thread and suggestion in the story.
		total: number;
		onClose: () => void;
	} = $props();

	let scope = $state<'finished' | 'all'>('finished');
	let busy = $state(false);

	function notes(n: number) {
		return n === 1 ? '1 note' : `${n} notes`;
	}
</script>

<div
	class="modal-backdrop"
	role="presentation"
	data-over-menus
	onclick={(event) => {
		if (event.target === event.currentTarget && !busy) onClose();
	}}
>
	<div
		class="modal-panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="clear-reviews-title"
		use:modal={{ close: onClose, initialFocus: 'input[name="scope"]:checked' }}
	>
		<div class="modal-head">
			<div class="modal-head-main">
				<h2 class="modal-title" id="clear-reviews-title">Clear review notes</h2>
				<p class="modal-sub">For the whole story, not only this scene.</p>
			</div>
			<button class="icon-btn sm" type="button" aria-label="Close" onclick={onClose}>
				<Icon name="close" size={14} />
			</button>
		</div>
		<form
			method="POST"
			action="?/clearReviews"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update();
					busy = false;
					onClose();
				};
			}}
		>
			<input type="hidden" name="seenAt" value={seenAt} />
			<div class="modal-body">
				<fieldset class="cr-group">
					<legend class="visually-hidden">What to clear</legend>
					<label class="choice">
						<input
							type="radio"
							name="scope"
							value="finished"
							aria-describedby="clear-finished-hint"
							bind:group={scope}
						/>
						<span>
							Finished notes only ({notes(finished)})
							<span class="choice-hint" id="clear-finished-hint">
								Resolved comments and accepted or rejected suggestions. Open ones stay.
							</span>
						</span>
					</label>
					<label class="choice">
						<input
							type="radio"
							name="scope"
							value="all"
							aria-describedby="clear-all-hint"
							bind:group={scope}
						/>
						<span>
							Everything ({notes(total)})
							<span class="choice-hint" id="clear-all-hint">
								Every comment and suggestion, open or finished, yours included.
							</span>
						</span>
					</label>
				</fieldset>
				<p class="cr-warning">
					Cleared notes and their replies are deleted, yours and your reviewers'. Your text and your
					saved drafts do not change.
				</p>
			</div>
			<div class="modal-foot">
				<div class="modal-foot-note"></div>
				<button class="btn btn-sm btn-secondary" type="button" onclick={onClose}>Cancel</button>
				<button
					class="btn btn-sm btn-danger"
					type="submit"
					disabled={busy || (scope === 'finished' ? finished : total) === 0}
				>
					Clear notes
				</button>
			</div>
		</form>
	</div>
</div>

<style>
	.cr-group {
		border: 0;
		margin: 0;
		padding: 0;
	}
	.cr-warning {
		margin: var(--space-3) 0 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
