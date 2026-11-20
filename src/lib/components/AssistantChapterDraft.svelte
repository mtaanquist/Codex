<script module lang="ts">
	// Brief forms the writer has open, by chapter, so one half typed is still
	// there after the panel was closed or another chapter was opened. Kept for
	// the page's life; a reload starts fresh.
	type OpenForm = {
		brief: string;
		targetWords: number;
		pov: string;
		scenes: Record<string, { chosen: boolean; brief: string }>;
	};
	const openForms: Record<string, OpenForm | undefined> = {};
</script>

<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { apiErrorMessage } from '#lib/format';
	import { post } from '#lib/api';
	import { pollPause, trackedJobs } from '#lib/activity.svelte';
	import { followChapterDraft, sceneDraftPath, startChapterDraft } from '#lib/assistant-actions';
	import {
		MAX_DRAFT_BRIEF_CHARS,
		MAX_DRAFT_POV_CHARS,
		MAX_DRAFT_WORDS,
		MIN_DRAFT_WORDS,
		CHAPTER_CAP_ADVICE,
		type ChapterDraftDefaults,
		type ChapterDraftEstimate,
		type ChapterDraftView,
		type SceneDraftStatus
	} from '#lib/scene-draft';
	import DraftCostNote from './DraftCostNote.svelte';
	import FormStatus from './FormStatus.svelte';
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
		decided = 0,
		onRequestTaken,
		onClose
	}: {
		storyId: string;
		chapterId: string;
		// Set when the writer asked to draft this chapter (the /draft-chapter
		// command or the chapter's menu); a new object each time. showOnly (a
		// link to the chapter's drafts) shows the drafts waiting and opens no
		// form.
		request?: { brief: string; showOnly?: boolean } | null;
		// Goes up each time a scene's draft is kept or discarded in its own
		// card, so the list here is read again.
		decided?: number;
		// Called once a request has been acted on, so it is not acted on again.
		onRequestTaken?: () => void;
		// Called when the card closes while the writer was in it, so the panel
		// can put keyboard focus somewhere useful.
		onClose?: () => void;
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
	// The drafts could not be read back; the card keeps what it has and retries.
	let unread = $state(false);

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

	function scope() {
		return { storyId, chapterId };
	}

	// The chapter's undecided drafts, null when it has none, undefined when
	// they could not be read (offline, a server fault): not the same as none.
	async function readRun(): Promise<ChapterDraftView | null | undefined> {
		try {
			const query = new URLSearchParams(scope());
			const response = await fetch(`/api/assistant/draft/chapter?${query}`);
			if (!response.ok) return undefined;
			return ((await response.json()) as { run: ChapterDraftView | null }).run;
		} catch {
			return undefined;
		}
	}

	// Reads the drafts, trying again until there is an answer. Null also when
	// the card has gone meanwhile; callers check `alive`.
	async function readRunSurely(): Promise<ChapterDraftView | null> {
		const startedAt = Date.now();
		for (;;) {
			const found = await readRun();
			if (!alive) return null;
			if (found !== undefined) {
				unread = false;
				return found;
			}
			unread = true;
			await pollPause(startedAt);
			if (!alive) return null;
		}
	}

	// Runs a change to what the card shows, and keeps keyboard focus when the
	// control that had it went away: on the card while it still shows, else
	// back with the panel.
	async function step(change: () => void) {
		const inside = card?.contains(document.activeElement) ?? false;
		change();
		await tick();
		if (!inside || card?.contains(document.activeElement)) return;
		if (card) card.focus();
		else onClose?.();
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
		const startedAt = Date.now();
		try {
			while (alive && view === 'run' && writing) {
				await pollPause(startedAt);
				if (!alive || view !== 'run') return;
				const fresh = await readRun();
				if (!alive || view !== 'run') return;
				// Not read this time: the list stays, and the next round tries again.
				unread = fresh === undefined;
				if (fresh === undefined) continue;
				if (!fresh) {
					// Stopped before anything was written, or all decided elsewhere.
					await step(() => {
						run = null;
						view = 'hidden';
					});
					return;
				}
				await step(() => (run = fresh));
			}
		} finally {
			polling = false;
		}
	}

	async function reveal() {
		await tick();
		card?.scrollIntoView({ block: 'nearest' });
	}

	// Opens the brief form: with what was typed into it before, when it was
	// left open, else empty with the chapter's scenes to choose from.
	async function openForm(typed: string, focus = true) {
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
		const open = openForms[chapterId];
		brief = typed || open?.brief || '';
		pov = open?.pov ?? '';
		if (!response.ok) {
			error = response.message;
			rows = [];
		} else {
			chapterTitle = response.chapterTitle;
			targetWords = open?.targetWords ?? response.targetWords;
			rows = response.scenes.map((scene) => {
				const was = open?.scenes[scene.sceneId];
				return {
					...scene,
					brief: was?.brief || scene.brief,
					// A scene with text is left for the writer to choose: its draft could
					// only be added as a new scene.
					chosen: !scene.hasDraft && (was ? was.chosen : !scene.hasText)
				};
			});
		}
		view = 'form';
		if (!focus) return;
		await reveal();
		briefEl?.focus();
	}

	// The open form is remembered as it is typed.
	$effect(() => {
		if (view !== 'form' || rows.length === 0) return;
		openForms[chapterId] = {
			brief,
			targetWords,
			pov,
			scenes: Object.fromEntries(
				rows.map((row) => [row.sceneId, { chosen: row.chosen, brief: row.brief }])
			)
		};
	});

	onMount(() => {
		if (openForms[chapterId]) void openForm('', false);
		else {
			void readRunSurely().then((found) => {
				if (!alive || view !== 'hidden') return;
				if (found) show(found);
			});
		}
		return () => {
			alive = false;
		};
	});

	// The writer asked to draft this chapter, or followed a link to its
	// drafts. A run still under way shows instead of the form; drafts only
	// waiting to be decided do not stand in the way of a new run, but they are
	// what a link is for.
	let handled: { brief: string } | null = null;
	$effect(() => {
		const asked = request;
		if (!asked || asked === handled) return;
		handled = asked;
		onRequestTaken?.();
		void (async () => {
			const found = await readRunSurely();
			if (!alive) return;
			if (found && (found.jobId || asked.showOnly)) {
				show(found);
				await reveal();
				card?.focus();
			} else if (!asked.showOnly) await openForm(asked.brief);
		})();
	});

	// A scene's draft was decided in its own card: drop it from the list.
	let seenDecided = untrack(() => decided);
	$effect(() => {
		if (decided === seenDecided) return;
		seenDecided = decided;
		if (untrack(() => view) !== 'run') return;
		void readRunSurely().then((fresh) => {
			if (!alive || view !== 'run') return;
			void step(() => {
				run = fresh;
				if (!fresh) view = 'hidden';
			});
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
		delete openForms[chapterId];
		const skipped = started.skipped;
		const found = await readRunSurely();
		if (!alive) return;
		await step(() => {
			if (found) show(found);
			else view = 'hidden';
			leftOut = skipped;
		});
		await reveal();
	}

	// The form's one main button: it counts the cost, then starts the run.
	const confirmed = $derived(estimate !== null && !estimate.overCap);

	const STATUS: Record<SceneDraftStatus, string> = {
		pending: 'Waiting',
		running: 'Being written',
		ready: 'Ready',
		failed: 'Not written',
		accepted: 'Kept',
		discarded: 'Discarded'
	};

	async function cancelForm() {
		delete openForms[chapterId];
		estimate = null;
		error = '';
		// Back to the chapter's waiting drafts, when it has some.
		const found = await readRun();
		if (!alive) return;
		if (found) {
			show(found);
			await tick();
			card?.focus();
		} else {
			view = 'hidden';
			onClose?.();
		}
	}
</script>

{#if view !== 'hidden'}
	<div
		class="assist-card assist-card-stack"
		bind:this={card}
		role="group"
		aria-label="Chapter draft"
		tabindex="-1"
	>
		<div class="assist-card-head">
			<Icon name="sparkles" size={13} />
			{view === 'run' ? 'Drafts in' : 'Draft'}
			{label}
		</div>

		{#if view === 'loading'}
			<p class="assist-card-note">Loading...</p>
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
				<p class="assist-card-note">
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
				<DraftCostNote {estimate} scenes={estimate.scenes} capAdvice={CHAPTER_CAP_ADVICE} />
				{#if estimate.skipped.length > 0}
					<p class="assist-card-note">
						{estimate.skipped.length === 1
							? 'One scene you chose has a draft waiting, so it is left out.'
							: `${estimate.skipped.length} scenes you chose have a draft waiting, so they are left out.`}
					</p>
				{/if}
			{/if}
			<FormStatus block {error} />
			<div class="assist-card-actions">
				{#if rows.length > 0}
					<!-- One button for both steps, so the keyboard stays on it. It is
					     not disabled while it works, which would drop focus. -->
					<button
						class="btn btn-primary"
						type="button"
						disabled={!formReady}
						aria-busy={working}
						onclick={confirmed ? start : checkCost}
					>
						{#if confirmed}
							{working ? 'Starting...' : 'Draft the chapter'}
						{:else}
							{working ? 'Counting...' : 'Check the cost'}
						{/if}
					</button>
				{/if}
				<button class="btn" type="button" onclick={cancelForm}>
					{rows.length > 0 ? 'Cancel' : 'Close'}
				</button>
			</div>
			{#if rows.length > 0}
				<p class="field-hint">
					Each scene's draft is shown to you first. Your scenes stay as they are until you choose
					what to do with each draft.
				</p>
			{/if}
		{:else if run}
			<p class="assist-card-note" role="status">
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
				<p class="assist-card-note">
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
			{#if unread}
				<p class="assist-card-note" role="status">Could not check on these drafts. Trying again.</p>
			{/if}
			<FormStatus block error={job?.stopError} />
			{#if writing}
				<div class="assist-card-actions">
					<button
						class="btn"
						type="button"
						disabled={!job?.stop || job.stopping}
						onclick={() => job?.stop?.()}
					>
						{job?.stopping ? 'Stopping...' : 'Stop'}
					</button>
				</div>
				<p class="field-hint">Stopping keeps the scenes already drafted.</p>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.draft-pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: var(--space-2);
	}
	.draft-scenes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.draft-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.draft-state {
		flex: none;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
</style>
