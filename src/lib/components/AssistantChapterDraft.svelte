<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { apiErrorMessage, formatNumber } from '#lib/format';
	import { post } from '#lib/api';
	import { trackedJobs } from '#lib/activity.svelte';
	import { followChapterDraft, sceneDraftPath, startChapterDraft } from '#lib/assistant-actions';
	import {
		MAX_DRAFT_BRIEF_CHARS,
		MAX_DRAFT_POV_CHARS,
		MAX_DRAFT_WORDS,
		MIN_DRAFT_WORDS,
		type ChapterDraftDefaults,
		type ChapterDraftEstimate,
		type ChapterDraftView,
		type SceneDraftStatus
	} from '#lib/scene-draft';
	import Icon from './Icon.svelte';

	// A chapter draft in the Assistant panel: the brief form with a line per
	// scene, the cost to confirm, and the list of the chapter's drafts while
	// they are written and until each is kept or discarded. Each drafted scene
	// is decided on its own, in that scene's draft card (AssistantDraft); this
	// card only starts the run, follows it, and links to the scenes.
	let {
		storyId,
		chapterId,
		request = null,
		decided = 0
	}: {
		storyId: string;
		chapterId: string;
		// Set when the writer asked to draft this chapter (the /draft-chapter
		// command or the chapter's menu); a new object each time.
		request?: { brief: string } | null;
		// Goes up each time a scene's draft is kept or discarded in its own
		// card, so the list here is read again.
		decided?: number;
	} = $props();

	type View = 'hidden' | 'loading' | 'form' | 'run';
	let view = $state<View>('hidden');
	let run = $state<ChapterDraftView | null>(null);
	let card = $state<HTMLDivElement>();
	let briefEl = $state<HTMLTextAreaElement>();
	let alive = true;

	// The brief form.
	type Row = { sceneId: string; title: string | null; brief: string; chosen: boolean } & Pick<
		ChapterDraftDefaults['scenes'][number],
		'hasText' | 'hasDraft'
	>;
	let brief = $state('');
	let targetWords = $state(800);
	let pov = $state('');
	let rows = $state<Row[]>([]);
	let chapterTitle = $state<string | null>(null);
	let estimate = $state<ChapterDraftEstimate | null>(null);
	let working = $state(false);
	let error = $state('');
	// Scenes left out of the run just started, because they had a draft waiting.
	let leftOut = $state(0);

	const label = $derived(chapterTitle ? `"${chapterTitle}"` : 'this chapter');
	const writing = $derived(
		run?.scenes.some((scene) => scene.status === 'pending' || scene.status === 'running') ?? false
	);
	const settledCount = $derived(
		run?.scenes.filter((scene) => scene.status !== 'pending' && scene.status !== 'running')
			.length ?? 0
	);
	const readyCount = $derived(run?.scenes.filter((scene) => scene.status === 'ready').length ?? 0);
	// The job as the activity center follows it, for its Stop.
	const job = $derived(
		run?.jobId ? trackedJobs.list.find((tracked) => tracked.id === run?.jobId) : undefined
	);

	const POLL_MS = 4000;

	function scope() {
		return { storyId, chapterId };
	}

	async function readRun(): Promise<ChapterDraftView | null> {
		try {
			const query = new URLSearchParams(scope());
			const response = await fetch(`/api/assistant/draft/chapter?${query}`);
			if (!response.ok) return null;
			return ((await response.json()) as { run: ChapterDraftView | null }).run;
		} catch {
			return null;
		}
	}

	let polling = false;
	// Shows the chapter's drafts and keeps the list current while scenes are
	// still being written.
	function show(found: ChapterDraftView) {
		run = found;
		chapterTitle = found.chapterTitle;
		error = '';
		view = 'run';
		if (found.jobId) {
			void followChapterDraft({ jobId: found.jobId, storyId, chapterId, label });
		}
		void poll();
	}
	async function poll() {
		if (polling) return;
		polling = true;
		try {
			while (alive && view === 'run' && writing) {
				await new Promise((resolve) => setTimeout(resolve, POLL_MS));
				if (!alive || view !== 'run') return;
				const fresh = await readRun();
				if (!alive || view !== 'run') return;
				if (!fresh) {
					// Stopped before anything was written, or all decided elsewhere.
					run = null;
					view = 'hidden';
					return;
				}
				run = fresh;
			}
		} finally {
			polling = false;
		}
	}

	async function reveal() {
		await tick();
		card?.scrollIntoView({ block: 'nearest' });
	}

	async function openForm(typed: string) {
		error = '';
		estimate = null;
		leftOut = 0;
		view = 'loading';
		const response = await post<ChapterDraftDefaults>(
			'/api/assistant/draft/chapter',
			{ ...scope(), defaults: true },
			'Could not open the draft form.'
		);
		if (!alive) return;
		brief = typed;
		pov = '';
		if (!response.ok) {
			error = response.message;
			rows = [];
		} else {
			chapterTitle = response.chapterTitle;
			targetWords = response.targetWords;
			rows = response.scenes.map((scene) => ({
				...scene,
				// A scene with text is left for the writer to choose: its draft could
				// only be added as a new scene.
				chosen: !scene.hasDraft && !scene.hasText
			}));
		}
		view = 'form';
		await reveal();
		briefEl?.focus();
	}

	onMount(() => {
		void readRun().then((found) => {
			if (!alive || view !== 'hidden') return;
			if (found) show(found);
		});
		return () => {
			alive = false;
		};
	});

	// The writer asked to draft this chapter. A run still under way shows
	// instead; drafts only waiting to be decided do not stand in the way.
	let handled: { brief: string } | null = null;
	$effect(() => {
		const asked = request;
		if (!asked || asked === handled) return;
		handled = asked;
		void (async () => {
			const found = await readRun();
			if (!alive) return;
			if (found?.jobId) {
				show(found);
				await reveal();
			} else await openForm(asked.brief);
		})();
	});

	// A scene's draft was decided in its own card: drop it from the list.
	let seenDecided = untrack(() => decided);
	$effect(() => {
		if (decided === seenDecided) return;
		seenDecided = decided;
		if (untrack(() => view) !== 'run') return;
		void readRun().then((fresh) => {
			if (!alive || view !== 'run') return;
			run = fresh;
			if (!fresh) view = 'hidden';
		});
	});

	const chosen = $derived(rows.filter((row) => row.chosen && !row.hasDraft));
	const formReady = $derived(
		chosen.length > 0 &&
			(brief.trim() !== '' || chosen.every((row) => row.brief.trim() !== '')) &&
			Number.isFinite(Number(targetWords)) &&
			Number(targetWords) >= MIN_DRAFT_WORDS &&
			Number(targetWords) <= MAX_DRAFT_WORDS
	);

	function formBody() {
		return {
			...scope(),
			brief: brief.trim(),
			targetWords: Number(targetWords),
			pov: pov.trim(),
			scenes: chosen.map((row) => ({ sceneId: row.sceneId, brief: row.brief.trim() }))
		};
	}

	// Counts what the drafts would send before anything runs.
	async function checkCost() {
		if (!formReady || working) return;
		working = true;
		error = '';
		estimate = null;
		try {
			const response = await fetch('/api/assistant/draft/chapter', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...formBody(), estimate: true })
			});
			if (response.ok) estimate = (await response.json()) as ChapterDraftEstimate;
			else error = await apiErrorMessage(response, 'The Assistant could not count the draft.');
		} catch {
			error = 'Something went wrong reaching the Assistant.';
		} finally {
			working = false;
		}
	}

	async function start() {
		if (!estimate || estimate.overCap || working) return;
		working = true;
		error = '';
		const started = await startChapterDraft({ ...formBody(), label });
		if (!alive) return;
		working = false;
		if (!started.ok) {
			error = started.message;
			return;
		}
		leftOut = started.skipped;
		const found = await readRun();
		if (!alive) return;
		if (!found) {
			view = 'hidden';
			return;
		}
		show(found);
		await reveal();
	}

	function costPhrase(est: ChapterDraftEstimate): string {
		const count = `${est.scenes} ${est.scenes === 1 ? 'scene' : 'scenes'}`;
		const size = `This drafts ${count}. It sends about ${formatNumber(est.estTokens)} tokens and writes about ${formatNumber(est.estCompletionTokens)}`;
		if (est.estCostUsd === undefined) return `${size}.`;
		return est.estCostUsd < 0.01
			? `${size} (less than $0.01).`
			: `${size} (about $${est.estCostUsd.toFixed(2)}).`;
	}

	const STATUS: Record<SceneDraftStatus, string> = {
		pending: 'Waiting',
		running: 'Being written',
		ready: 'Ready',
		failed: 'Not written',
		accepted: 'Kept',
		discarded: 'Discarded'
	};

	function cancelForm() {
		estimate = null;
		error = '';
		// Back to the chapter's waiting drafts, when it has some.
		view = 'hidden';
		void readRun().then((found) => {
			if (alive && view === 'hidden' && found) show(found);
		});
	}
</script>

{#if view !== 'hidden'}
	<div class="draft-card" bind:this={card} role="group" aria-label="Chapter draft">
		<div class="draft-head">
			<Icon name="sparkles" size={13} />
			{view === 'run' ? 'Drafts in' : 'Draft'}
			{label}
		</div>

		{#if view === 'loading'}
			<p class="draft-note">Loading...</p>
		{:else if view === 'form'}
			{#if rows.length > 0}
				<div class="field">
					<label for="chapter-draft-brief">What happens in this chapter</label>
					<textarea
						id="chapter-draft-brief"
						class="textarea"
						rows="3"
						maxlength={MAX_DRAFT_BRIEF_CHARS}
						bind:this={briefEl}
						bind:value={brief}
						oninput={() => (estimate = null)}></textarea>
				</div>
				<div class="draft-pair">
					<div class="field">
						<label for="chapter-draft-words">Words per scene</label>
						<input
							id="chapter-draft-words"
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
						<label for="chapter-draft-pov">Point of view (optional)</label>
						<input
							id="chapter-draft-pov"
							class="input"
							type="text"
							maxlength={MAX_DRAFT_POV_CHARS}
							bind:value={pov}
							oninput={() => (estimate = null)}
						/>
					</div>
				</div>
				<p class="draft-note">
					Tick the scenes to draft, and say what happens in each. They are drafted in order.
				</p>
				<ul class="draft-scenes">
					{#each rows as row, index (row.sceneId)}
						{@const name = row.title || `Scene ${index + 1}`}
						<li>
							<label class="choice">
								<input
									type="checkbox"
									bind:checked={row.chosen}
									disabled={row.hasDraft}
									aria-describedby={row.hasDraft || row.hasText
										? `chapter-draft-hint-${index}`
										: undefined}
									onchange={() => (estimate = null)}
								/>
								<span>
									{name}
									{#if row.hasDraft}
										<span class="choice-hint" id="chapter-draft-hint-{index}">
											This scene has a draft waiting. Keep or discard it first.
										</span>
									{:else if row.hasText}
										<span class="choice-hint" id="chapter-draft-hint-{index}">
											This scene already has text. Its draft carries on from that text, and can only
											be added as a new scene.
										</span>
									{/if}
								</span>
							</label>
							{#if row.chosen && !row.hasDraft}
								<textarea
									class="textarea"
									rows="2"
									maxlength={MAX_DRAFT_BRIEF_CHARS}
									aria-label="What happens in {name}"
									placeholder="What happens in this scene"
									bind:value={row.brief}
									oninput={() => (estimate = null)}></textarea>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if estimate}
				<p class="draft-note" role="status">{costPhrase(estimate)}</p>
				{#if estimate.skipped.length > 0}
					<p class="draft-note">
						{estimate.skipped.length === 1
							? 'One scene you chose has a draft waiting, so it is left out.'
							: `${estimate.skipped.length} scenes you chose have a draft waiting, so they are left out.`}
					</p>
				{/if}
				{#if estimate.overCap && estimate.capUsd !== undefined}
					<p class="draft-error" role="alert">
						That is over your spend cap of ${estimate.capUsd.toFixed(2)}, so the draft will not run.
						Choose fewer scenes or a shorter length, or raise the cap under Account, Assistant.
					</p>
				{:else if estimate.limitedToWords !== undefined}
					<p class="draft-note">
						The reply length set for Write stops each scene at about {formatNumber(
							estimate.limitedToWords
						)} words. For longer scenes, raise Longest reply for Write in its Tune window under Account,
						Assistant.
					</p>
				{/if}
			{/if}
			{#if error}
				<p class="draft-error" role="alert">{error}</p>
			{/if}
			<div class="draft-actions">
				{#if rows.length > 0}
					{#if estimate && !estimate.overCap}
						<button class="btn btn-primary" type="button" disabled={working} onclick={start}>
							{working ? 'Starting...' : 'Draft the chapter'}
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
				{/if}
				<button class="btn" type="button" onclick={cancelForm}>
					{rows.length > 0 ? 'Cancel' : 'Close'}
				</button>
			</div>
			{#if rows.length > 0}
				<p class="draft-hint">
					Each scene's draft is shown to you first. Your scenes stay as they are until you choose
					what to do with each draft.
				</p>
			{/if}
		{:else if run}
			<p class="draft-note" role="status">
				{#if writing}
					The Assistant is drafting these scenes in the background, one at a time: {settledCount} of
					{run.scenes.length} done. You can keep working, and you will be notified when it finishes.
				{:else if readyCount > 0}
					Open each scene to read its draft, then keep or discard it.
				{:else}
					None of these scenes has a draft to keep.
				{/if}
			</p>
			{#if leftOut > 0}
				<p class="draft-note">
					{leftOut === 1
						? 'One scene you chose had a draft waiting, so it was left out.'
						: `${leftOut} scenes you chose had a draft waiting, so they were left out.`}
				</p>
			{/if}
			<ul class="draft-scenes">
				{#each run.scenes as scene (scene.draftId)}
					<li class="draft-row">
						{#if scene.status === 'ready' || scene.status === 'failed'}
							<a href={sceneDraftPath(storyId, scene.sceneId)}>
								{scene.sceneTitle || 'Untitled scene'}
							</a>
						{:else}
							<span>{scene.sceneTitle || 'Untitled scene'}</span>
						{/if}
						<span class="draft-state">{STATUS[scene.status]}</span>
					</li>
				{/each}
			</ul>
			{#if job?.stopError}
				<p class="draft-error" role="alert">{job.stopError}</p>
			{/if}
			{#if writing}
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
				<p class="draft-hint">Stopping keeps the scenes already drafted.</p>
			{/if}
		{/if}
	</div>
{/if}

<style>
	/* The scene draft card (AssistantDraft), with a row per scene. */
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
	.draft-scenes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.draft-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
	}
	.draft-state {
		flex: none;
		font-size: 12px;
		color: var(--text-faint);
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
