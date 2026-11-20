<script lang="ts">
	import { enhance } from '#lib/enhance';
	import Icon from './Icon.svelte';
	import { paragraphWindow } from '#lib/paragraphs';
	import { patternName, type ReviewSuggestion, type ReviewThread } from '#lib/review-ui';

	// The guided pass over an Assistant pattern note: one of its edits at a time,
	// in reading order, shown inside its whole paragraph. The author accepts,
	// edits, or skips each, and can stop at any point. The pass itself (which
	// edit is current, what was skipped) lives in the review workspace.

	let {
		note,
		step,
		scene,
		position,
		total,
		followUp,
		onAccepted,
		onSkip,
		beforeAccept,
		onStop,
		onHeld
	}: {
		note: ReviewThread;
		// The current edit, or null when none is left.
		step: ReviewSuggestion | null;
		// The scene the current edit sits in.
		scene: { bodyMd: string; title: string | null; chapterTitle: string } | null;
		position: number;
		total: number;
		// The edit came from the re-read after an earlier accept.
		followUp: boolean;
		onAccepted: (
			id: string,
			accepted: { bodyMd: string; baseHash: string } | null,
			replacement: string | undefined
		) => void;
		onSkip: (id: string) => void;
		// Saves the open editor first, so the accept is checked against the
		// writer's latest text; false when that save failed.
		beforeAccept: () => Promise<boolean>;
		onStop: () => void;
		// Told whether the writer is rewording or accepting the current edit, so
		// the workspace does not swap the step out from under them.
		onHeld: (held: boolean) => void;
	} = $props();

	const name = $derived(patternName(note.comments[0]?.body ?? ''));

	// The paragraph around the edit, split at the change so it renders inline.
	const context = $derived.by(() => {
		if (!step?.anchor || !scene) return null;
		const body = scene.bodyMd;
		const span = paragraphWindow(body, step.anchor.start, step.anchor.end);
		const from = Math.min(span.start, step.anchor.start);
		const to = Math.max(span.end, step.anchor.end);
		return {
			before: body.slice(from, step.anchor.start),
			after: body.slice(step.anchor.end, to)
		};
	});

	let editing = $state(false);
	let draft = $state('');
	let busy = $state(false);
	let failure = $state<string | null>(null);
	// A new step starts clean. Keyed on the id, not the object: a data refresh
	// rebuilds the step object and must not throw away wording being typed.
	const stepId = $derived(step?.id);
	$effect(() => {
		void stepId;
		editing = false;
		failure = null;
	});

	$effect(() => {
		onHeld(editing || busy);
	});

	function startEdit() {
		draft = step?.replacement ?? '';
		editing = true;
	}
</script>

<div class="review-panel">
	<div class="inspector-head pp-head">
		<button class="back-btn" type="button" onclick={onStop}>
			<span class="rv-back-ic"><Icon name="chevron" size={14} /></span> Stop
		</button>
		<span class="inspector-kind pp-title">{name}</span>
		<span class="pp-count"
			>{#if step}{position} of {total}{/if}</span
		>
	</div>
	<div class="rv-panel-scroll">
		{#if step}
			<div class="rv-card is-draft" style="--auth: var(--cat-violet);">
				<div class="rv-card-top">
					<div class="rv-who">
						<div class="rv-who-name">{scene?.title?.trim() || 'Untitled scene'}</div>
						<div class="rv-when">{scene?.chapterTitle ?? ''}</div>
					</div>
					{#if followUp}<span class="pill"><Icon name="sparkles" size={11} /> Follow-up</span>{/if}
				</div>

				{#if context}
					<div class="rv-diff pp-para">
						{context.before}{#if step.original}<span class="rv-diff-del">{step.original}</span
							>{/if}{#if !editing && step.replacement}<span class="rv-diff-ins"
								>{step.replacement}</span
							>{/if}{context.after}
					</div>
				{:else}
					<div class="rv-anchor-lost">
						<Icon name="close" size={12} /> The text changed since; skip this one.
					</div>
					<div class="rv-diff">
						{#if step.original}<span class="rv-diff-del">{step.original}</span>{/if}
						{#if step.replacement}<span class="rv-diff-ins">{step.replacement}</span>{/if}
					</div>
				{/if}

				<form
					method="POST"
					action="?/acceptSuggestion"
					use:enhance={async ({ cancel }) => {
						busy = true;
						failure = null;
						// The wording as submitted, not as it reads after the save.
						const replacement = editing ? draft : undefined;
						if (!(await beforeAccept())) {
							busy = false;
							failure = 'Your latest typing could not be saved, so nothing was accepted.';
							cancel();
							return;
						}
						const id = step!.id;
						return async ({ result, update }) => {
							busy = false;
							if (result.type === 'success') {
								const { bodyMd, baseHash } = result.data ?? {};
								onAccepted(
									id,
									typeof bodyMd === 'string' && typeof baseHash === 'string'
										? { bodyMd, baseHash }
										: null,
									replacement
								);
							} else if (result.type === 'failure') {
								failure =
									typeof result.data?.message === 'string'
										? result.data.message
										: 'That change could not be accepted.';
							}
							await update();
						};
					}}
				>
					<input type="hidden" name="suggestionId" value={step.id} />
					{#if editing}
						<span class="rv-draft-k rv-draft-to">Your wording</span>
						<textarea
							name="replacement"
							class="rv-draft-input"
							aria-label="Your wording"
							bind:value={draft}></textarea>
					{/if}
					{#if failure}<p class="rv-anchor-lost">{failure}</p>{/if}
					<div class="rv-actions">
						{#if context}
							<button
								class="btn btn-sm btn-primary"
								type="submit"
								disabled={busy || (editing && !draft.trim() && step.replacement !== '')}
							>
								<Icon name="check" size={13} />
								{editing ? 'Accept my wording' : 'Accept'}
							</button>
							{#if !editing}
								<button class="btn btn-sm btn-secondary" type="button" onclick={startEdit}>
									<Icon name="pencil" size={13} /> Edit
								</button>
							{/if}
						{/if}
						<button
							class="btn btn-sm btn-ghost"
							type="button"
							disabled={busy}
							onclick={() => onSkip(step!.id)}
						>
							Skip
						</button>
					</div>
				</form>
			</div>
		{:else}
			<div class="empty-state tight">
				<div class="empty-state-icon"><Icon name="check-circle" size={22} /></div>
				<p class="empty-state-text">You have been through every change in this note.</p>
				<div class="rv-actions">
					{#if note.resolvedAt === null}
						<form
							method="POST"
							action="?/resolve"
							use:enhance={() =>
								async ({ update }) => {
									onStop();
									await update();
								}}
						>
							<input type="hidden" name="threadId" value={note.id} />
							<button class="btn btn-sm btn-primary" type="submit">Resolve the note</button>
						</form>
					{/if}
					<button class="btn btn-sm btn-ghost" type="button" onclick={onStop}>Close</button>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	/* Stop and the count take equal side columns so the title sits centred
	   between them, clear of both. */
	.pp-head {
		display: grid;
		grid-template-columns: minmax(max-content, 1fr) minmax(0, auto) minmax(max-content, 1fr);
		gap: 12px;
	}
	.pp-head .back-btn {
		justify-self: start;
	}
	.pp-title {
		text-align: center;
	}
	.pp-count {
		justify-self: end;
		white-space: nowrap;
		font-size: var(--text-meta);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	/* The paragraph keeps its line breaks, like the manuscript. */
	.pp-para {
		white-space: pre-wrap;
	}
</style>
