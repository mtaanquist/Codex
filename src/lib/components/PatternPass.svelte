<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '#lib/enhance';
	import Icon from './Icon.svelte';
	import { paragraphWindow } from '#lib/paragraphs';
	import { patternName, type ReviewSuggestion, type ReviewThread } from '#lib/review-ui';

	// The guided pass over an Assistant pattern note: every edit of the note as
	// one list of cards, worked one at a time. The current edit is shown inside
	// its whole paragraph with the buttons; the rest are faded, with what became
	// of them, so the writer can scroll back over what they did. The author
	// accepts, edits, or skips each, and can stop at any point. The pass itself
	// (which edit is current, what was skipped) lives in the review workspace.

	let {
		note,
		edits,
		step,
		scene,
		sceneOf,
		skipped,
		accepted,
		rereading,
		position,
		total,
		onAccepted,
		onSkip,
		beforeAccept,
		onStop
	}: {
		note: ReviewThread;
		// Every edit of the note, decided or not, in the order the pass shows them.
		edits: ReviewSuggestion[];
		// The current edit, or null when none is left.
		step: ReviewSuggestion | null;
		// The scene the current edit sits in.
		scene: { bodyMd: string; title: string | null; chapterTitle: string } | null;
		// The title and chapter of any edit's scene, for the faded cards.
		sceneOf: (sceneId: string) => { title: string | null; chapterTitle: string } | null;
		// Skipped in this pass: still pending, but behind the writer.
		skipped: (id: string) => boolean;
		// Accepted in this pass, before the page data says so.
		accepted: (id: string) => boolean;
		// A re-read after an accept is still running, so a follow-up may yet come.
		rereading: boolean;
		position: number;
		total: number;
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

	// The suggested wording the writer's own started from, so a revision that
	// lands while they type can be shown beside it.
	let draftFrom = $state('');
	function startEdit() {
		draft = draftFrom = step?.replacement ?? '';
		editing = true;
	}
	const revisedUnder = $derived(editing && step != null && step.replacement !== draftFrom);

	// Each new step scrolls its card to the top of the list, leaving a little of
	// the card before it in view. Only a new step does, so a writer scrolling
	// back over the list is not pulled away while they read.
	let scroller = $state<HTMLElement | null>(null);
	const reduceMotion = () =>
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	function cardOf(id: string): HTMLElement | null {
		return scroller?.querySelector<HTMLElement>(`[data-edit="${CSS.escape(id)}"]`) ?? null;
	}
	// After a refused accept the pressed button may be gone or disabled, which
	// would leave the keyboard on the page; it goes to the step's card.
	async function refocus(id: string) {
		await tick();
		cardOf(id)?.focus({ preventScroll: true });
	}
	// The button the writer pressed goes with the step, so focus moves to the
	// new step rather than falling back to the page, unless the writer had
	// already moved it somewhere outside the pass.
	// Keyed on the step, or for the end of the pass on whether it is still
	// waiting, so a re-read finishing under a step on screen moves nothing.
	let shownKey: string | null = null;
	$effect(() => {
		const id = stepId;
		const key = id ?? (rereading ? 'end:waiting' : 'end:done');
		if (!scroller || key === shownKey) return;
		// The wait at the end turning into the end itself is the same place: it
		// only picks up focus the swap dropped, without scrolling.
		const settled = shownKey === 'end:waiting' && key === 'end:done';
		shownKey = key;
		void tick().then(() => {
			const card = id ? cardOf(id) : scroller?.querySelector<HTMLElement>('.pp-end');
			const active = document.activeElement;
			const lost = !active || active === document.body;
			if (settled) {
				if (card && lost) card.focus({ preventScroll: true });
				return;
			}
			card?.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
			if (card && (lost || scroller?.contains(active))) card.focus({ preventScroll: true });
		});
	});

	// A follow-up's link scrolls to the edit it follows and marks it briefly.
	let flashId = $state<string | null>(null);
	function showOriginal(id: string) {
		const card = cardOf(id);
		if (!card) return;
		card.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
		card.focus({ preventScroll: true });
		flashId = id;
		setTimeout(() => {
			if (flashId === id) flashId = null;
		}, 1600);
	}
	const listed = $derived(new Set(edits.map((e) => e.id)));

	function outcome(edit: ReviewSuggestion): string | null {
		if (edit.status === 'accepted' || accepted(edit.id)) return 'Accepted';
		if (edit.status === 'rejected') return 'Rejected';
		if (skipped(edit.id)) return 'Skipped';
		return null;
	}
</script>

<div class="review-panel">
	<div class="inspector-head pp-head">
		<button class="back-btn" type="button" onclick={onStop}>
			<span class="rv-back-ic"><Icon name="chevron" size={14} /></span> Stop
		</button>
		<span class="inspector-kind pp-title">{name}</span>
		<span class="pp-count" aria-live="polite"
			>{#if step}{position} of {total}{/if}</span
		>
	</div>
	<div class="rv-panel-scroll" bind:this={scroller}>
		{#snippet followUpPill(edit: ReviewSuggestion)}
			{#if edit.followsId}
				<span class="pill"><Icon name="sparkles" size={11} /> Follow-up</span>
			{/if}
		{/snippet}
		{#snippet followsLink(edit: ReviewSuggestion)}
			{#if edit.followsId && listed.has(edit.followsId)}
				<button class="pp-follows" type="button" onclick={() => showOriginal(edit.followsId!)}>
					Follows an earlier change
				</button>
			{/if}
		{/snippet}

		{#each edits as edit (edit.id)}
			{#if step && edit.id === step.id}
				<div
					class="rv-card is-draft pp-card"
					style="--auth: var(--cat-violet);"
					data-edit={step.id}
					aria-current="step"
					tabindex="-1"
				>
					<div class="rv-card-top">
						<div class="rv-who">
							<div class="rv-who-name">{scene?.title?.trim() || 'Untitled scene'}</div>
							<div class="rv-when">{scene?.chapterTitle ?? ''}</div>
						</div>
						{@render followUpPill(step)}
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
					{#if step.reason}
						<p class="rv-reason"><span class="rv-reason-k">Why:</span>{step.reason}</p>
					{/if}
					{@render followsLink(step)}

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
								void refocus(step!.id);
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
									// The edit may have been revised; show it as it is now.
									await invalidateAll();
								}
								await update();
								if (result.type !== 'success') await refocus(id);
							};
						}}
					>
						<input type="hidden" name="suggestionId" value={step.id} />
						<input type="hidden" name="seen" value={step.stamp ?? ''} />
						{#if revisedUnder}
							<span class="rv-draft-k">The suggestion now reads</span>
							<div class="rv-diff pp-revised">
								{#if step.replacement}<span class="rv-diff-ins">{step.replacement}</span
									>{:else}Remove these words.{/if}
							</div>
						{/if}
						{#if editing}
							<span class="rv-draft-k rv-draft-to">Your wording</span>
							<textarea
								name="replacement"
								class="rv-draft-input"
								aria-label="Your wording"
								bind:value={draft}></textarea>
						{/if}
						<!-- Once the passage is gone the notice above says so, and
						     there is no Accept left for this line to be about. -->
						{#if failure && context}<p class="pp-failure" role="alert">{failure}</p>{/if}
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
				{@const where = sceneOf(edit.sceneId)}
				{@const done = outcome(edit)}
				<div
					class="rv-card pp-card pp-faded"
					class:pp-flash={flashId === edit.id}
					tabindex="-1"
					style="--auth: var(--cat-violet);"
					data-edit={edit.id}
				>
					<div class="rv-card-top">
						<div class="rv-who">
							<div class="rv-who-name">{where?.title?.trim() || 'Untitled scene'}</div>
							<div class="rv-when">{where?.chapterTitle ?? ''}</div>
						</div>
						{@render followUpPill(edit)}
						{#if done}<span class="pill">{done}</span>{/if}
					</div>
					<div class="rv-diff">
						{#if edit.original}<span class="rv-diff-del">{edit.original}</span>{/if}
						{#if edit.replacement}<span class="rv-diff-ins">{edit.replacement}</span>{/if}
					</div>
					{@render followsLink(edit)}
				</div>
			{/if}
		{/each}

		{#if !step && rereading}
			<div class="empty-state tight pp-end" tabindex="-1">
				<div class="empty-state-icon"><Icon name="sparkles" size={22} /></div>
				<p class="empty-state-text">
					The Assistant is still re-reading your last changes and may suggest a follow-up.
				</p>
			</div>
		{:else if !step}
			<div class="empty-state tight pp-end" tabindex="-1">
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
	/* Leaves a little of the card before in view when a step scrolls up. */
	.pp-card {
		scroll-margin-top: 36px;
		cursor: default;
	}
	/* The cards around the current one: faded and without buttons, so the
	   current one stands out. */
	.pp-faded {
		opacity: 0.7;
		transition: opacity 0.2s;
	}
	.pp-faded:hover,
	.pp-faded:focus-within {
		opacity: 0.85;
	}
	.pp-faded .rv-card-top {
		margin-bottom: 6px;
	}
	.pp-flash {
		opacity: 1;
		border-color: color-mix(in oklab, var(--auth) 55%, transparent);
		box-shadow: 0 0 0 3px color-mix(in oklab, var(--auth) 13%, transparent);
	}
	.pp-follows {
		display: block;
		margin-top: 8px;
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent, var(--text));
		font: inherit;
		font-size: var(--text-meta);
		cursor: pointer;
	}
	.pp-follows:hover {
		text-decoration: underline;
	}
	.pp-card .pill + .pill {
		margin-left: -4px;
	}
	/* The paragraph keeps its line breaks, like the manuscript. */
	.pp-para {
		white-space: pre-wrap;
	}
</style>
