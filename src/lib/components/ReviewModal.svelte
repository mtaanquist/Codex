<script lang="ts">
	import { reviewModal, closeReviewModal } from '$lib/review-modal.svelte';
	import {
		reviewSceneWithAssistant,
		startBackgroundReview,
		type JobStartFailure
	} from '$lib/assistant-actions';
	import { REVIEW_CATEGORIES, type ReviewCategory, type ReviewLevel } from '$lib/review-shape';

	// The review modal: pick a level (this scene, this chapter, the whole story)
	// and which categories the Assistant should check, then start the review. The
	// page that owns the story renders this and supplies its chapters and scenes;
	// the open request comes from the shared store, raised by the row menu, the
	// command palette, the review pane, or the chat's /review command.

	let {
		storyId,
		storySlug,
		chapters,
		scenes,
		defaultSceneId = null
	}: {
		storyId: string;
		storySlug: string;
		chapters: { id: string; title: string | null }[];
		scenes: { id: string; chapterId: string | null; title: string | null }[];
		// The scene open in the editor, used when the request names no scene.
		defaultSceneId?: string | null;
	} = $props();

	const reviewHref = $derived(`/stories/${storySlug}/review`);

	// The scene and chapter the review can target, from the request or the page.
	const sceneId = $derived(reviewModal.request.sceneId ?? defaultSceneId ?? null);
	const scene = $derived(scenes.find((s) => s.id === sceneId) ?? null);
	const chapterId = $derived(reviewModal.request.chapterId ?? scene?.chapterId ?? null);
	const chapter = $derived(chapters.find((c) => c.id === chapterId) ?? null);

	function chapterLabel(c: { id: string; title: string | null }): string {
		if (c.title && c.title.trim()) return c.title;
		const i = chapters.findIndex((x) => x.id === c.id);
		return `Chapter ${i + 1}`;
	}

	// Which levels are offered, narrowed to what the context allows.
	const levels = $derived.by(() => {
		const out: { id: ReviewLevel; label: string }[] = [];
		if (sceneId) out.push({ id: 'scene', label: 'This scene' });
		if (chapterId) out.push({ id: 'chapter', label: 'This chapter' });
		out.push({ id: 'story', label: 'The whole story' });
		return out;
	});

	// What the running review reports back while it works. The modal stays open
	// on a chapter or story pass and polls the job; closing it leaves the review
	// running, tracked by the card in the corner.
	// The job reports 'running', 'done' and 'failed'; 'notstarted' is this
	// component's own, set when the enqueue never produced a job to poll. The
	// state is left open so a state added on the server still lands in the
	// "no longer running" branch rather than reading as progress.
	type Progress = {
		state: string;
		phase?: 'summaries' | 'scenes' | 'consistency' | 'done';
		// Why the run never started, shown under the notstarted heading. refused
		// marks a server rejection, which is what a duplicate of a review already
		// running comes back as.
		message?: string;
		refused?: boolean;
		completed?: number;
		total?: number;
		currentSceneTitle?: string | null;
		reviewed?: number;
		notes?: number;
		failures?: { sceneTitle?: string | null; message: string }[];
		// The run stopped because it reached the account's spend cap.
		capped?: boolean;
		spentUsd?: number | null;
	};

	// What the pre-flight estimate reports, and the confirm step built on it. A
	// cost figure is present only when the model has a known price. Only the
	// fields the panel shows are declared.
	type EstimateLine = { label: string; tokens?: number; note?: string };
	type Estimate = {
		scenes: number;
		estTokens: number;
		lines?: EstimateLine[];
		estCostUsd?: number;
		// What the model's replies are expected to cost, where the endpoint prices
		// them; shown alongside the send figure when it is there.
		estCompletionCostUsd?: number;
		warnUsd: number;
		capUsd?: number;
		capEnforceable: boolean;
	};

	// The estimate is advisory: anything that does not carry the two figures the
	// panel is built on is treated as no estimate at all, and the run goes ahead.
	function isEstimate(value: unknown): value is Estimate {
		const e = value as Estimate | null;
		return (
			!!e &&
			typeof e === 'object' &&
			typeof e.scenes === 'number' &&
			typeof e.estTokens === 'number'
		);
	}

	const money = (usd: number) => usd.toFixed(2);
	const thousands = (n: number) => n.toLocaleString('en-US');

	// The done phase never reaches here: the finished branch above it catches it.
	const PHASE_LABEL: Record<string, string> = {
		summaries: 'Updating scene summaries',
		scenes: 'Reading the scenes',
		consistency: 'Comparing the scenes to each other'
	};

	let progress = $state<Progress | null>(null);
	// Bumped on every close and every new run, so a poll loop left over from an
	// earlier run stops writing to the panel.
	let runToken = 0;

	const POLL_MS = 3000;
	const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	async function pollJob(jobId: string, token: number) {
		while (token === runToken) {
			await delay(POLL_MS);
			if (token !== runToken) return;
			try {
				const response = await fetch(
					`/api/assistant/job-status?kind=review&id=${encodeURIComponent(jobId)}`
				);
				if (!response.ok) continue;
				const next = (await response.json()) as Progress;
				if (token !== runToken) return;
				progress = next;
				if (next.state !== 'running') return;
			} catch {
				// A blip leaves the panel as it was; the next poll catches up.
			}
		}
	}

	// The confirm step: null until an estimate comes back, then the panel that
	// says what the run would send before anything is queued.
	let estimate = $state<Estimate | null>(null);
	let estimating = $state(false);
	const warned = $derived(
		estimate?.estCostUsd !== undefined && estimate.estCostUsd > estimate.warnUsd
	);

	function close() {
		runToken += 1;
		progress = null;
		estimate = null;
		estimating = false;
		closeReviewModal();
	}

	let level = $state<ReviewLevel>('story');
	// The category checkboxes. "General notes" is the sparing pass; the other
	// three are the exhaustive categories.
	let general = $state(true);
	let picked = $state<Record<ReviewCategory, boolean>>({
		mechanics: false,
		prose: false,
		lore: false
	});

	// Reset the form each time the modal opens, choosing the most specific level
	// the context offers.
	let lastOpen = false;
	$effect(() => {
		if (reviewModal.open && !lastOpen) {
			const requested = reviewModal.request.level;
			const available = levels.map((l) => l.id);
			level = requested && available.includes(requested) ? requested : (available[0] ?? 'story');
			general = true;
			picked = { mechanics: false, prose: false, lore: false };
			runToken += 1;
			progress = null;
			estimate = null;
			estimating = false;
		}
		lastOpen = reviewModal.open;
	});

	// The category set sent to the server: the exhaustive picks, or empty for the
	// sparing general-notes pass.
	const categories = $derived(REVIEW_CATEGORIES.filter((c) => picked[c]));

	const CATEGORY_OPTIONS: { id: ReviewCategory; label: string }[] = [
		{ id: 'mechanics', label: 'Spelling and grammar' },
		{ id: 'prose', label: 'Prose and style' },
		{ id: 'lore', label: 'Entities and lore' }
	];

	// Asks what the run would send before queueing it. An estimate that fails
	// never blocks the review: the run starts as it always did.
	async function start() {
		if (level === 'scene' && sceneId) {
			close();
			await reviewSceneWithAssistant(
				sceneId,
				reviewHref,
				categories,
				scene?.title?.trim() ? `"${scene.title}"` : 'this scene'
			);
			return;
		}
		estimating = true;
		try {
			const response = await fetch('/api/assistant/review-job', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					storyId,
					chapterId: level === 'chapter' ? chapterId : undefined,
					categories,
					estimate: true
				})
			});
			if (!response.ok) throw new Error(`estimate failed: ${response.status}`);
			const body: unknown = await response.json();
			if (isEstimate(body)) {
				estimate = body;
				estimating = false;
				return;
			}
			estimating = false;
		} catch (err) {
			console.warn('review estimate unavailable, starting the review anyway:', err);
			estimating = false;
		}
		await run();
	}

	async function run() {
		// A chapter or story pass runs in the background: the modal turns into a
		// progress panel over it until the writer closes it.
		estimate = null;
		runToken += 1;
		const token = runToken;
		progress = { state: 'running' };
		// Without a job id there is nothing to poll: the run never started, so the
		// panel says so rather than reporting a review that finished with no notes.
		const onJobId = (jobId: string | null, failure?: JobStartFailure) => {
			if (token !== runToken) return;
			if (jobId) {
				void pollJob(jobId, token);
				return;
			}
			progress = {
				state: 'notstarted',
				message: failure?.message,
				refused: failure?.reason === 'rejected'
			};
		};
		if (level === 'chapter' && chapterId && chapter) {
			await startBackgroundReview({
				storyId,
				chapterId,
				categories,
				label: `"${chapterLabel(chapter)}"`,
				reviewHref,
				onJobId
			});
		} else {
			await startBackgroundReview({
				storyId,
				categories,
				label: 'your story',
				reviewHref,
				onJobId
			});
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	}
</script>

{#if reviewModal.open}
	<div
		class="modal-backdrop"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) close();
		}}
		onkeydown={onKeydown}
	>
		<div
			class="modal-panel modal-lg"
			role="dialog"
			aria-modal="true"
			aria-label="Review with the Assistant"
		>
			<div class="modal-head">
				<div class="modal-head-main">
					<h2 class="modal-title">Review with the Assistant</h2>
				</div>
			</div>

			<div class="modal-body">
				{#if progress}
					<div class="rm-progress">
						{#if progress.state === 'failed'}
							<p class="rm-phase">The review did not finish.</p>
							<p class="rm-note">
								Check the Assistant endpoint on your account page, then try again.
							</p>
						{:else if progress.state === 'notstarted'}
							<p class="rm-phase">The review could not be started.</p>
							<p class="rm-note">{progress.message ?? 'Try again in a moment.'}</p>
							{#if progress.refused}
								<p class="rm-note">
									If a review of this story is already running, that one carries on. The card in the
									bottom corner shows it.
								</p>
							{/if}
						{:else if progress.capped}
							<p class="rm-phase">
								Stopped after {progress.reviewed ?? 0} of {progress.total ?? 0} scenes at about ${money(
									progress.spentUsd ?? 0
								)}.
							</p>
							<p class="rm-note">Raise the cap in settings or run the review again to continue.</p>
						{:else if progress.state === 'done' || progress.phase === 'done'}
							<p class="rm-phase">Review finished.</p>
							<p class="rm-note">
								{#if progress.notes}
									Open the review page to read the {progress.notes} note{progress.notes === 1
										? ''
										: 's'} it left.
								{:else}
									Nothing to read yet. Notes appear on the review page when the Assistant leaves
									any.
								{/if}
							</p>
						{:else if progress.state !== 'running'}
							<p class="rm-phase">The review is no longer running.</p>
							<p class="rm-note">
								Open the review page to see anything it left, or start the review again.
							</p>
						{:else}
							<p class="rm-phase">
								{PHASE_LABEL[progress.phase ?? 'summaries'] ?? 'Working through the story'}...
							</p>
							{#if progress.phase === 'scenes' && progress.total}
								<p class="rm-note">
									Scene {Math.min((progress.completed ?? 0) + 1, progress.total)} of {progress.total}{progress.currentSceneTitle
										? `: ${progress.currentSceneTitle}`
										: ''}
								</p>
							{:else}
								<p class="rm-note">You can close this window. The review keeps running.</p>
							{/if}
						{/if}
						{#if progress.failures?.length}
							<ul class="rm-failures">
								{#each progress.failures as failure, i (i)}
									<li>
										{#if failure.sceneTitle}<strong>{failure.sceneTitle}:</strong>{/if}
										{failure.message}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{:else if estimate}
					<div class="rm-confirm" class:rm-warn={warned}>
						<p class="rm-phase">
							{estimate.scenes} scene{estimate.scenes === 1 ? '' : 's'} to review, about {thousands(
								estimate.estTokens
							)} tokens to send.
						</p>
						{#if estimate.lines?.length}
							<ul class="rm-lines">
								{#each estimate.lines as line, i (i)}
									<li>
										<span class="rm-line-label">{line.label}</span>
										<span class="rm-line-value"
											>{line.tokens !== undefined
												? `${thousands(line.tokens)} tokens`
												: line.note}</span
										>
									</li>
								{/each}
							</ul>
						{/if}
						{#if estimate.estCostUsd !== undefined}
							<p class="rm-note">
								That is about ${money(estimate.estCostUsd)} to send{estimate.estCompletionCostUsd !==
								undefined
									? `, plus about $${money(estimate.estCompletionCostUsd)} for the replies.`
									: "; the model's replies cost extra."}
							</p>
						{:else}
							<p class="rm-note">This model has no price on record, so the cost cannot be shown.</p>
						{/if}
						{#if estimate.capUsd !== undefined && !estimate.capEnforceable}
							<p class="rm-note">
								Your spend cap of ${money(estimate.capUsd)} cannot be applied to a model with no known
								price.
							</p>
						{/if}
						{#if warned}
							<p class="rm-note">
								That is more than your warning limit of ${money(estimate.warnUsd)}. Review a chapter
								at a time to spend less.
							</p>
						{/if}
					</div>
				{:else}
					<fieldset class="rm-group">
						<legend>What to review</legend>
						{#each levels as option (option.id)}
							<label class="rm-radio">
								<input type="radio" name="review-level" value={option.id} bind:group={level} />
								<span>{option.label}</span>
							</label>
						{/each}
					</fieldset>

					<fieldset class="rm-group">
						<legend>What to check</legend>
						<label class="rm-check">
							<input type="checkbox" bind:checked={general} disabled={categories.length > 0} />
							<span>
								General notes
								<span class="rm-hint">a few high-value observations</span>
							</span>
						</label>
						{#each CATEGORY_OPTIONS as option (option.id)}
							<label class="rm-check">
								<input type="checkbox" bind:checked={picked[option.id]} />
								<span>{option.label}</span>
							</label>
						{/each}
						<p class="rm-note">
							{#if categories.length === 0}
								The Assistant leaves a few high-value notes.
							{:else if categories.length === REVIEW_CATEGORIES.length}
								A full copyedit: every category, plus a cross-scene consistency pass.
							{:else}
								An exhaustive pass over the categories you picked.
							{/if}
						</p>
					</fieldset>
				{/if}
			</div>

			<div class="modal-foot">
				<div class="modal-foot-note"></div>
				{#if progress}
					<button class="btn btn-sm btn-primary" type="button" onclick={close}>Close</button>
				{:else if estimate}
					<button class="btn btn-sm btn-secondary" type="button" onclick={() => (estimate = null)}
						>Back</button
					>
					<button class="btn btn-sm btn-primary" type="button" onclick={run}>
						{warned ? 'Start anyway' : 'Start review'}
					</button>
				{:else}
					<button class="btn btn-sm btn-secondary" type="button" onclick={close}>Cancel</button>
					<button
						class="btn btn-sm btn-primary"
						type="button"
						onclick={start}
						disabled={estimating}
					>
						{estimating ? 'Checking...' : 'Start review'}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	/* The overlay, panel, head and footer come from the modal primitive; what is
	   left here is the shape of the two option groups. */
	.rm-group {
		border: 0;
		margin: 0 0 14px;
		padding: 0;
	}
	.rm-group legend {
		padding: 0;
		margin-bottom: 7px;
		font-size: var(--text-micro);
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.rm-radio,
	.rm-check {
		display: flex;
		align-items: baseline;
		gap: 9px;
		padding: 5px 0;
		font-size: var(--text-base);
		color: var(--text);
		cursor: pointer;
	}
	.rm-radio input,
	.rm-check input {
		margin: 0;
		accent-color: var(--accent);
	}
	.rm-hint {
		display: block;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.rm-note {
		margin: 8px 0 0;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.rm-progress,
	.rm-confirm {
		padding: 4px 0;
	}
	/* Above the warning threshold the confirm step is deliberately louder, so an
	   expensive run is not started by reflex. */
	.rm-confirm.rm-warn {
		padding: 12px 14px;
		border: 1px solid var(--danger, #b4402f);
		border-radius: var(--radius-sm, 4px);
		background: color-mix(in srgb, var(--danger, #b4402f) 8%, transparent);
	}
	.rm-confirm.rm-warn .rm-phase {
		font-weight: 600;
	}
	.rm-phase {
		margin: 0;
		font-size: var(--text-base);
		color: var(--text);
	}
	/* The estimate's line items: a quiet breakdown under the headline figure. */
	.rm-lines {
		margin: 10px 0 0;
		padding: 0;
		list-style: none;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.rm-lines li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 3px 0;
	}
	.rm-line-value {
		flex: 0 1 auto;
		text-align: right;
	}
	.rm-failures {
		margin: 12px 0 0;
		padding-left: 18px;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.rm-failures li {
		margin-bottom: 4px;
	}
</style>
