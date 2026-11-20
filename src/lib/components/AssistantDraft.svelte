<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { apiErrorMessage, formatNumber } from '#lib/format';
	import { post } from '#lib/api';
	import { trackedJobs } from '#lib/activity.svelte';
	import { followSceneDraft, startSceneDraft } from '#lib/assistant-actions';
	import {
		MAX_DRAFT_BRIEF_CHARS,
		MAX_DRAFT_POV_CHARS,
		MAX_DRAFT_WORDS,
		MIN_DRAFT_WORDS,
		type SceneDraftDefaults,
		type SceneDraftEstimate,
		type SceneDraftView
	} from '#lib/scene-draft';
	import Icon from './Icon.svelte';

	// A scene draft in the Assistant panel: the brief form, the cost to confirm,
	// the wait while the background job writes it, and the finished draft to
	// keep or discard. Mounted for the open scene; it shows nothing until the
	// writer asks for a draft or the scene already has one. The draft is never
	// put into the story from here without the writer choosing how.
	let {
		storyId,
		sceneId,
		request = null,
		onLand,
		onDecided
	}: {
		storyId: string;
		sceneId: string;
		// Set when the writer asked to draft this scene (the /draft command or
		// the scene's menu); a new object each time, so asking again reopens it.
		request?: { brief: string } | null;
		// Keeps the draft: into the scene itself (fill) or as a new scene after
		// it (add). The page lands pending saves first and opens the result.
		// Resolves to a message when it did not go through.
		onLand: (draftId: string, action: 'fill' | 'add', text: string) => Promise<string | null>;
		// Called once a draft is kept or discarded, so a list of the chapter's
		// drafts can drop it.
		onDecided?: () => void;
	} = $props();

	type View = 'hidden' | 'loading' | 'form' | 'draft';
	let view = $state<View>('hidden');
	let draft = $state<SceneDraftView | null>(null);
	let card = $state<HTMLDivElement>();
	let briefEl = $state<HTMLTextAreaElement>();
	let alive = true;

	// The brief form.
	let brief = $state('');
	let targetWords = $state(800);
	let pov = $state('');
	let sceneTitle = $state<string | null>(null);
	let estimate = $state<SceneDraftEstimate | null>(null);
	let working = $state(false);
	let error = $state('');

	// The finished draft, as the writer edits it before keeping it.
	let text = $state('');
	let landing = $state<'fill' | 'add' | 'discard' | null>(null);

	const label = $derived(sceneTitle ? `"${sceneTitle}"` : 'this scene');
	const running = $derived(draft?.status === 'pending' || draft?.status === 'running');
	// The job as the activity center follows it, for its Stop.
	const job = $derived(
		draft?.jobId ? trackedJobs.list.find((tracked) => tracked.id === draft?.jobId) : undefined
	);

	function scope() {
		return { storyId, sceneId };
	}

	async function readDraft(): Promise<SceneDraftView | null> {
		try {
			const query = new URLSearchParams(scope());
			const response = await fetch(`/api/assistant/draft?${query}`);
			if (!response.ok) return null;
			return ((await response.json()) as { draft: SceneDraftView | null }).draft;
		} catch {
			return null;
		}
	}

	function show(found: SceneDraftView) {
		draft = found;
		sceneTitle = found.sceneTitle;
		text = found.textMd;
		error = '';
		view = 'draft';
		if (found.status === 'pending' || found.status === 'running') void follow(found);
	}

	const POLL_MS = 4000;

	// Waits for the job writing the draft, then reads the draft back. A draft
	// that is one of a chapter's is ready before its job ends, so it is read
	// again every few seconds instead.
	async function follow(found: SceneDraftView, done?: Promise<void>) {
		if (found.inChapterRun) {
			let latest: SceneDraftView | null = found;
			while (
				latest?.id === found.id &&
				(latest.status === 'pending' || latest.status === 'running')
			) {
				await new Promise((resolve) => setTimeout(resolve, POLL_MS));
				if (!alive || draft?.id !== found.id) return;
				latest = await readDraft();
				if (!alive || draft?.id !== found.id) return;
			}
			if (!latest || latest.id !== found.id) {
				draft = null;
				view = 'hidden';
				return;
			}
			show(latest);
			await reveal();
			return;
		}
		if (!found.jobId) return;
		await (done ??
			followSceneDraft({ jobId: found.jobId, storyId, sceneId, label: sceneLabel(found) }));
		if (!alive || draft?.id !== found.id) return;
		const settled = await readDraft();
		if (!alive) return;
		// Stopped, or discarded elsewhere: nothing left to show.
		if (!settled || settled.id !== found.id) {
			draft = null;
			view = 'hidden';
			return;
		}
		show(settled);
		await reveal();
	}

	function sceneLabel(found: { sceneTitle: string | null }) {
		return found.sceneTitle ? `"${found.sceneTitle}"` : 'this scene';
	}

	async function reveal() {
		await tick();
		card?.scrollIntoView({ block: 'nearest' });
	}

	// Opens the brief form with what the scene suggests, unless the scene
	// already has a draft to decide first.
	async function openForm(typed: string, from?: SceneDraftView) {
		error = '';
		estimate = null;
		if (from) {
			brief = from.brief;
			targetWords = from.targetWords;
			pov = from.pov ?? '';
			view = 'form';
		} else {
			view = 'loading';
			const response = await post<SceneDraftDefaults>(
				'/api/assistant/draft',
				{ ...scope(), defaults: true },
				'Could not open the draft form.'
			);
			if (!alive) return;
			if (!response.ok) {
				error = response.message;
				brief = typed;
			} else {
				brief = typed || response.brief;
				targetWords = response.targetWords;
				sceneTitle = response.sceneTitle;
			}
			pov = '';
			view = 'form';
		}
		await reveal();
		briefEl?.focus();
	}

	onMount(() => {
		void readDraft().then((found) => {
			if (!alive || view !== 'hidden') return;
			if (found) show(found);
		});
		return () => {
			alive = false;
		};
	});

	// The writer asked to draft this scene. A draft already there shows instead.
	let handled: { brief: string } | null = null;
	$effect(() => {
		const asked = request;
		if (!asked || asked === handled) return;
		handled = asked;
		void (async () => {
			const found = draft ?? (await readDraft());
			if (!alive) return;
			if (found) {
				show(found);
				await reveal();
			} else await openForm(asked.brief);
		})();
	});

	function formBody() {
		return { ...scope(), brief: brief.trim(), targetWords: Number(targetWords), pov: pov.trim() };
	}
	const formReady = $derived(
		brief.trim() !== '' &&
			Number.isFinite(Number(targetWords)) &&
			Number(targetWords) >= MIN_DRAFT_WORDS &&
			Number(targetWords) <= MAX_DRAFT_WORDS
	);

	// Counts what the draft would send before anything runs.
	async function checkCost() {
		if (!formReady || working) return;
		working = true;
		error = '';
		estimate = null;
		try {
			const response = await fetch('/api/assistant/draft', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...formBody(), estimate: true })
			});
			if (response.ok) estimate = (await response.json()) as SceneDraftEstimate;
			else error = await apiErrorMessage(response, 'The Assistant could not count the draft.');
		} catch {
			error = 'Something went wrong reaching the Assistant.';
		} finally {
			working = false;
		}
	}

	async function run() {
		if (!estimate || estimate.overCap || working) return;
		working = true;
		error = '';
		const started = await startSceneDraft({ ...formBody(), label });
		if (!alive) return;
		working = false;
		if (!started.ok) {
			error = started.message;
			// The scene may have a draft from another window by now.
			const found = await readDraft();
			if (alive && found) show(found);
			return;
		}
		const found = await readDraft();
		if (!alive) return;
		if (!found) {
			view = 'hidden';
			return;
		}
		draft = found;
		sceneTitle = found.sceneTitle;
		view = 'draft';
		void follow(found, started.done);
	}

	function costPhrase(est: SceneDraftEstimate): string {
		const size = `This sends about ${formatNumber(est.estTokens)} tokens and writes about ${formatNumber(est.estCompletionTokens)}`;
		if (est.estCostUsd === undefined) return `${size}.`;
		return est.estCostUsd < 0.01
			? `${size} (less than $0.01).`
			: `${size} (about $${est.estCostUsd.toFixed(2)}).`;
	}

	async function land(action: 'fill' | 'add') {
		if (!draft || landing || !text.trim()) return;
		landing = action;
		error = '';
		const failed = await onLand(draft.id, action, text);
		if (!alive) return;
		landing = null;
		if (failed) {
			error = failed;
			// The scene may have gained text, so Fill may no longer be offered.
			const fresh = await readDraft();
			if (alive && fresh && fresh.id === draft.id) draft = { ...fresh };
			return;
		}
		draft = null;
		view = 'hidden';
		onDecided?.();
	}

	async function discard() {
		if (!draft || landing) return;
		landing = 'discard';
		error = '';
		const result = await post(
			`/api/assistant/draft/${draft.id}`,
			{ action: 'discard' },
			'Could not discard the draft.'
		);
		if (!alive) return;
		landing = null;
		if (!result.ok) {
			error = result.message;
			return;
		}
		draft = null;
		view = 'hidden';
		onDecided?.();
	}

	function cancelForm() {
		view = 'hidden';
		estimate = null;
		error = '';
	}
</script>

{#if view !== 'hidden'}
	<div class="draft-card" bind:this={card} role="group" aria-label="Scene draft">
		<div class="draft-head">
			<Icon name="sparkles" size={13} />
			{view === 'draft' && draft?.status === 'ready' ? 'Draft of' : 'Draft'}
			{label}
		</div>

		{#if view === 'loading'}
			<p class="draft-note">Loading...</p>
		{:else if view === 'form'}
			<div class="field">
				<label for="draft-brief">What happens in this scene</label>
				<textarea
					id="draft-brief"
					class="textarea"
					rows="4"
					maxlength={MAX_DRAFT_BRIEF_CHARS}
					bind:this={briefEl}
					bind:value={brief}
					oninput={() => (estimate = null)}></textarea>
			</div>
			<div class="draft-pair">
				<div class="field">
					<label for="draft-words">Length in words</label>
					<input
						id="draft-words"
						class="input"
						type="number"
						min={MIN_DRAFT_WORDS}
						max={MAX_DRAFT_WORDS}
						step="50"
						bind:value={targetWords}
						oninput={() => (estimate = null)}
					/>
				</div>
				<div class="field">
					<label for="draft-pov">Point of view (optional)</label>
					<input
						id="draft-pov"
						class="input"
						type="text"
						maxlength={MAX_DRAFT_POV_CHARS}
						bind:value={pov}
						oninput={() => (estimate = null)}
					/>
				</div>
			</div>
			{#if estimate}
				<p class="draft-note" role="status">{costPhrase(estimate)}</p>
				{#if estimate.overCap && estimate.capUsd !== undefined}
					<p class="draft-error" role="alert">
						That is over your spend cap of ${estimate.capUsd.toFixed(2)}, so the draft will not run.
						Ask for a shorter scene, or raise the cap under Account, Assistant.
					</p>
				{:else if estimate.limitedToWords !== undefined}
					<p class="draft-note">
						The reply length set for Write stops this draft at about {formatNumber(
							estimate.limitedToWords
						)} words. For a longer scene, raise Longest reply for Write in its Tune window under Account,
						Assistant.
					</p>
				{/if}
			{/if}
			{#if error}
				<p class="draft-error" role="alert">{error}</p>
			{/if}
			<div class="draft-actions">
				{#if estimate && !estimate.overCap}
					<button class="btn btn-primary" type="button" disabled={working} onclick={run}>
						{working ? 'Starting...' : 'Draft the scene'}
					</button>
				{:else}
					<button
						class="btn btn-primary"
						type="button"
						disabled={working || !formReady}
						onclick={checkCost}
					>
						{working ? 'Counting...' : 'Check the cost'}
					</button>
				{/if}
				<button class="btn" type="button" onclick={cancelForm}>Cancel</button>
			</div>
			<p class="draft-hint">
				The draft is shown here first. Your scene stays as it is until you choose what to do with
				it.
			</p>
		{:else if draft && running && draft.inChapterRun}
			<p class="draft-note" role="status">
				This scene is part of a chapter the Assistant is drafting in the background. Its draft shows
				here when it is written.
			</p>
		{:else if draft && running}
			<p class="draft-note" role="status">
				The Assistant is writing this draft in the background. You can keep working, and you will be
				notified when it is ready.
			</p>
			{#if job?.stopError}
				<p class="draft-error" role="alert">{job.stopError}</p>
			{/if}
			<div class="draft-actions">
				<button
					class="btn"
					type="button"
					disabled={!job?.stop || job.stopping}
					onclick={() => job?.stop?.()}
				>
					{job?.stopping ? 'Stopping...' : 'Stop'}
				</button>
			</div>
		{:else if draft?.status === 'ready'}
			{#if draft.note}
				<p class="draft-note">{draft.note}</p>
			{/if}
			<div class="field">
				<label for="draft-text">Read it, and change anything you like before keeping it</label>
				<textarea id="draft-text" class="textarea draft-text" rows="12" bind:value={text}
				></textarea>
			</div>
			{#if error}
				<p class="draft-error" role="alert">{error}</p>
			{/if}
			<div class="draft-actions">
				{#if draft.sceneEmpty}
					<button
						class="btn btn-primary"
						type="button"
						disabled={landing !== null || !text.trim()}
						onclick={() => land('fill')}
					>
						{landing === 'fill' ? 'Adding...' : 'Fill this scene'}
					</button>
				{/if}
				<button
					class={['btn', !draft.sceneEmpty && 'btn-primary']}
					type="button"
					disabled={landing !== null || !text.trim()}
					onclick={() => land('add')}
				>
					{landing === 'add' ? 'Adding...' : 'Add as a new scene after this one'}
				</button>
				<button class="btn" type="button" disabled={landing !== null} onclick={discard}>
					Discard
				</button>
			</div>
			<p class="draft-hint">
				{draft.sceneEmpty
					? 'Fill this scene puts the draft into the empty scene. The other choice adds it as a new scene.'
					: 'This scene already has text, so the draft is added as a new scene and your text stays as it is.'}
			</p>
		{:else if draft}
			<p class="draft-error" role="alert">
				{draft.note ?? 'The Assistant could not write this draft.'}
			</p>
			{#if error}
				<p class="draft-error" role="alert">{error}</p>
			{/if}
			<div class="draft-actions">
				<button
					class="btn btn-primary"
					type="button"
					disabled={landing !== null}
					onclick={() => draft && openForm('', draft)}
				>
					Try again
				</button>
				<button class="btn" type="button" disabled={landing !== null} onclick={discard}>
					Discard
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* The same card as a split proposal (AssistantProposal), with form rows. */
	.draft-card {
		margin-top: 8px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-card);
		padding: 10px 12px;
		font-size: 13px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	/* The card spaces its own rows. */
	.draft-card .field {
		margin-bottom: 0;
	}
	.draft-head {
		display: flex;
		align-items: center;
		gap: 7px;
		font-weight: 600;
		color: var(--text);
	}
	.draft-pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 8px;
	}
	.draft-text {
		font-family: var(--font-content);
		font-size: 14px;
		line-height: 1.5;
	}
	.draft-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.draft-note {
		margin: 0;
		color: var(--text-muted);
	}
	.draft-hint {
		margin: 0;
		font-size: 12px;
		color: var(--text-faint);
	}
	.draft-error {
		margin: 0;
		font-size: 12.5px;
		color: var(--danger-ink);
	}
</style>
