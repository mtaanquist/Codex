<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
<<<<<<< HEAD
	import { invalidateAll } from '$app/navigation';
=======
>>>>>>> origin/staging/non-assistant-polish
	import { enhance } from '#lib/enhance';
	import { modal } from '#lib/modal';
	import Icon from './Icon.svelte';
	import { authorColor, suggestionAuthor, type ReviewSuggestion } from '#lib/review-ui';

	// The review toolbar's dialog: every pending suggested edit on the open
	// scene, listed with what it changes, so the author can accept or reject
	// several at once and see exactly which ones. Author only.
	let {
		suggestions,
		beforeAccept,
		onAccepted,
		onClose
	}: {
		// The scene's pending suggestions, in reading order.
		suggestions: ReviewSuggestion[];
		// Saves the open editor first, so each accept is checked against the
		// writer's latest text; false when that save failed.
		beforeAccept: () => Promise<boolean>;
		// Called with the applied suggestion ids the moment the server confirms
		// them, before the page data reloads, so the live editor can apply them.
		onAccepted: (ids: string[], accepted: { bodyMd: string; baseHash: string } | null) => void;
		onClose: () => void;
	} = $props();

	// Everything starts ticked; the list is the chance to leave some out. Kept
	// as the ones left out, so an edit that arrives while the dialog is open
	// shows ticked like the rest.
	const unticked = new SvelteSet<string>();
	const ticked = $derived(suggestions.filter((s) => !unticked.has(s.id)));
	// An edit whose passage has changed since can be rejected but not accepted.
	const acceptable = $derived(ticked.filter((s) => !s.anchorLost));
	const allTicked = $derived(ticked.length === suggestions.length);

	let busy = $state(false);
	let note = $state<string | null>(null);

<<<<<<< HEAD
	// A decision under way finishes before the dialog goes, so its outcome is
	// always shown.
	function close() {
		if (!busy) onClose();
	}

=======
>>>>>>> origin/staging/non-assistant-polish
	function edits(n: number) {
		return n === 1 ? '1 edit' : `${n} edits`;
	}
</script>

<div
	class="modal-backdrop"
	role="presentation"
	data-over-menus
	onclick={(event) => {
<<<<<<< HEAD
		if (event.target === event.currentTarget) close();
=======
		if (event.target === event.currentTarget && !busy) onClose();
>>>>>>> origin/staging/non-assistant-polish
	}}
>
	<div
		class="modal-panel rd-panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="review-decide-title"
<<<<<<< HEAD
		use:modal={{ close }}
=======
		use:modal={{ close: onClose }}
>>>>>>> origin/staging/non-assistant-polish
	>
		<div class="modal-head">
			<div class="modal-head-main">
				<h2 class="modal-title" id="review-decide-title">Decide on suggested edits</h2>
				<p class="modal-sub">
					The edits suggested on this scene. Untick any you want to leave for later.
				</p>
			</div>
<<<<<<< HEAD
			<button class="icon-btn sm" type="button" aria-label="Close" onclick={close}>
				<Icon name="close" size={14} />
			</button>
		</div>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<form
			method="POST"
			action="?/decideSuggestions"
			onkeydown={(event) => {
				// Enter on a tick box would otherwise submit with the first button.
				if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
					event.preventDefault();
			}}
=======
			<button class="icon-btn sm" type="button" aria-label="Close" onclick={onClose}>
				<Icon name="close" size={14} />
			</button>
		</div>
		<form
			method="POST"
			action="?/decideSuggestions"
>>>>>>> origin/staging/non-assistant-polish
			use:enhance={async ({ formData, submitter, cancel }) => {
				const accept = submitter?.getAttribute('value') === 'accept';
				busy = true;
				note = null;
				if (accept) {
					formData.delete('suggestionId');
					for (const s of acceptable) formData.append('suggestionId', s.id);
					if (!(await beforeAccept())) {
						busy = false;
						note = 'Your latest typing could not be saved, so nothing was accepted.';
						cancel();
						return;
					}
				}
				return async ({ result, update }) => {
					if (result.type !== 'success') {
<<<<<<< HEAD
						// A refusal changed nothing. Anything else may have stopped part
						// of the way through, so the list is read again.
						if (result.type !== 'failure') await invalidateAll();
=======
						await update();
>>>>>>> origin/staging/non-assistant-polish
						busy = false;
						note =
							result.type === 'failure' && typeof result.data?.message === 'string'
								? result.data.message
<<<<<<< HEAD
								: `That did not finish. Some edits may have been ${accept ? 'accepted' : 'rejected'}; the list shows the ones still waiting.`;
=======
								: 'That did not work. Nothing was changed; try again.';
>>>>>>> origin/staging/non-assistant-polish
						return;
					}
					const data = result.data ?? {};
					const decided = Array.isArray(data.decided) ? (data.decided as string[]) : [];
					const failed = Array.isArray(data.failed) ? data.failed.length : 0;
					if (accept) {
						onAccepted(
							decided,
							typeof data.bodyMd === 'string' && typeof data.baseHash === 'string'
								? { bodyMd: data.bodyMd, baseHash: data.baseHash }
								: null
						);
					}
<<<<<<< HEAD
					// The boxes follow the ticked state, not the form's defaults.
					await update({ reset: false });
=======
					await update();
>>>>>>> origin/staging/non-assistant-polish
					busy = false;
					if (failed === 0) return onClose();
					note = `${edits(decided.length)} ${accept ? 'accepted' : 'rejected'}. ${edits(failed)} could not be ${
						accept ? 'accepted because the text changed' : 'rejected'
					}.`;
				};
			}}
		>
			<div class="modal-body">
				{#if note}
					<p class="form-error" role="alert">{note}</p>
				{/if}
				{#if suggestions.length === 0}
					<p>No suggested edits are waiting on this scene.</p>
				{:else}
					<label class="choice rd-all">
						<input
							type="checkbox"
							checked={allTicked}
							indeterminate={!allTicked && ticked.length > 0}
							onchange={(event) => {
								if (event.currentTarget.checked) unticked.clear();
								else for (const s of suggestions) unticked.add(s.id);
							}}
						/>
						<span>All {edits(suggestions.length)}</span>
					</label>
					<ul class="rd-list">
						{#each suggestions as s (s.id)}
							<li style="--auth: {authorColor(suggestionAuthor(s))};">
								<label class="choice">
									<input
										type="checkbox"
										name="suggestionId"
										value={s.id}
										checked={!unticked.has(s.id)}
										onchange={(event) => {
											if (event.currentTarget.checked) unticked.delete(s.id);
											else unticked.add(s.id);
										}}
									/>
									<span class="rd-edit">
										<span class="rv-diff">
<<<<<<< HEAD
											{#if s.original}<span class="visually-hidden">Remove:</span>
												<span class="rv-diff-del">{s.original}</span>{/if}
											{#if s.replacement}<span class="visually-hidden">Add:</span>
												<span class="rv-diff-ins">{s.replacement}</span>{/if}
=======
											{#if s.original}<span class="rv-diff-del">{s.original}</span>{/if}
											{#if s.replacement}<span class="rv-diff-ins">{s.replacement}</span>{/if}
>>>>>>> origin/staging/non-assistant-polish
										</span>
										<span class="choice-hint">
											{s.reviewerName}{s.anchorLost
												? ' - the text changed since; this can only be rejected'
												: ''}
										</span>
									</span>
								</label>
							</li>
						{/each}
					</ul>
					<p class="rd-warning">
						Accepting changes the text of this scene in each ticked place. Each change is saved in
						the scene's history.
					</p>
				{/if}
			</div>
			<div class="modal-foot">
				<div class="modal-foot-note">{ticked.length} of {suggestions.length} ticked</div>
				<button
					class="btn btn-sm btn-secondary"
					type="submit"
					name="decision"
					value="reject"
					disabled={busy || ticked.length === 0}
				>
					Reject {edits(ticked.length)}
				</button>
				<button
					class="btn btn-sm btn-primary"
					type="submit"
					name="decision"
					value="accept"
					disabled={busy || acceptable.length === 0}
				>
					Accept {edits(acceptable.length)}
				</button>
			</div>
		</form>
	</div>
</div>

<style>
	.rd-panel {
		width: min(560px, 100%);
	}
	.rd-all {
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border);
	}
	.rd-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rd-list li + li {
		border-top: 1px solid var(--border);
	}
	.rd-list .choice {
		padding: var(--space-2) 0;
	}
	.rd-edit {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.rd-edit :global(.rv-diff) {
		display: block;
		margin-bottom: 2px;
	}
	.rd-warning {
		margin: var(--space-3) 0 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
