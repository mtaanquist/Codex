<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { apiErrorMessage } from '#lib/format';
	import { post } from '#lib/api';
	import { pollPause, trackedJobs } from '#lib/activity.svelte';
	import { followSceneDraft, startSceneDraft } from '#lib/assistant-actions';
	import { createConfirmGuard } from '#lib/confirm-guard';
	import {
		adoptStored,
		draftBaseHashes,
		draftEdit,
		dropDraftEdit,
		releaseDraftEdit,
		type DraftEdit
	} from '#lib/draft-edits';
	import {
		dropDraftForm,
		keepDraftForm,
		readDraftForm,
		storedFields,
		storedWords
	} from '#lib/draft-forms';
	import {
		DRAFT_CHANGED_ELSEWHERE,
		FALLBACK_DRAFT_WORDS,
		MAX_DRAFT_BRIEF_CHARS,
		MAX_DRAFT_POV_CHARS,
		MAX_DRAFT_WORDS,
		MIN_DRAFT_WORDS,
		sceneCapAdvice,
		type SceneDraftDefaults,
		type SceneDraftEstimate,
		type SceneDraftView
	} from '#lib/scene-draft';
	import DraftCostNote from './DraftCostNote.svelte';
	import FormStatus from './FormStatus.svelte';
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
		canDraft = true,
		onLand,
		onDecided,
		onRequestTaken,
		onClose
	}: {
		storyId: string;
		sceneId: string;
		// Set when the writer asked to draft this scene (the /draft command or
		// the scene's menu); a new object each time, so asking again reopens it.
		// showOnly shows the draft the scene has and opens no form.
		request?: { brief: string; showOnly?: boolean } | null;
		// False while the Assistant is off for the story or the account: a draft
		// already written can still be kept or discarded, but none is asked for.
		canDraft?: boolean;
		// Keeps the draft: into the scene itself (fill) or as a new scene after
		// it (add). The page lands pending saves first and opens the result.
		// Resolves to a message when it did not go through.
		// baseHashes are the texts this window has saved (see save-bases).
		onLand: (
			draftId: string,
			action: 'fill' | 'add',
			text: string,
			baseHashes: string[]
		) => Promise<string | null>;
		// Called once a draft is kept or discarded, so a list of the chapter's
		// drafts can drop it.
		onDecided?: () => void;
		// Called once a request has been acted on, so it is not acted on again.
		onRequestTaken?: () => void;
		// Called when the card closes while the writer was in it, so the panel
		// can put keyboard focus somewhere useful.
		onClose?: () => void;
	} = $props();

	type View = 'hidden' | 'loading' | 'form' | 'draft' | 'gone';
	let view = $state<View>('hidden');
	let draft = $state<SceneDraftView | null>(null);
	let card = $state<HTMLDivElement>();
	let briefEl = $state<HTMLTextAreaElement>();
	let alive = true;

	// The brief form. It is remembered as it is typed (see draft-forms).
	type OpenForm = { brief: string; targetWords: number; pov: string; sceneTitle: string | null };
	function parseOpenForm(value: unknown): OpenForm | undefined {
		const form = storedFields(value);
		if (!form) return undefined;
		return {
			brief: typeof form.brief === 'string' ? form.brief : '',
			// Empty while the writer was retyping it: the usual length stands in.
			targetWords: storedWords(form.targetWords) ?? FALLBACK_DRAFT_WORDS,
			pov: typeof form.pov === 'string' ? form.pov : '',
			sceneTitle: typeof form.sceneTitle === 'string' ? form.sceneTitle : null
		};
	}
	let brief = $state('');
	let targetWords = $state(FALLBACK_DRAFT_WORDS);
	let pov = $state('');
	let sceneTitle = $state<string | null>(null);
	let estimate = $state<SceneDraftEstimate | null>(null);
	let working = $state(false);
	let error = $state('');

	// The finished draft, as the writer edits it before keeping it. The edit,
	// and the saving of it, live outside the card (see draft-edits), so they
	// outlive it; these mirror that state for the card to show.
	let text = $state('');
	let edit: DraftEdit | null = null;
	let saveError = $state('');
	// The draft was changed in another window since this copy was read.
	let changedElsewhere = $state(false);
	let landing = $state<'fill' | 'add' | 'discard' | null>(null);
	// The draft could not be read back; the card keeps what it has and retries.
	let unread = $state(false);
	// The draft the card showed was kept or discarded in another window. text
	// is what the writer had typed and not saved, left for them to copy; next
	// is the scene's newer draft, shown when they close this.
	let gone = $state<{ text: string; next: SceneDraftView | null } | null>(null);
	const GONE_MESSAGE = 'This draft was already kept or discarded in another window.';

	const label = $derived(sceneTitle ? `"${sceneTitle}"` : 'this scene');
	const running = $derived(draft?.status === 'pending' || draft?.status === 'running');
	// The form asks ("Draft this scene"); a draft under way or written is
	// named for what it is.
	const heading = $derived(
		view === 'form' || view === 'loading' ? 'Draft' : running ? 'Drafting' : 'Draft of'
	);
	// The job as the activity center follows it, for its Stop.
	const job = $derived(
		draft?.jobId ? trackedJobs.list.find((tracked) => tracked.id === draft?.jobId) : undefined
	);

	function scope() {
		return { storyId, sceneId };
	}

	// The scene's undecided draft, null when it has none, undefined when it
	// could not be read (offline, a server fault): not the same as none.
	async function readDraft(): Promise<SceneDraftView | null | undefined> {
		try {
			const query = new URLSearchParams(scope());
			const response = await fetch(`/api/assistant/draft?${query}`);
			if (!response.ok) return undefined;
			return ((await response.json()) as { draft: SceneDraftView | null }).draft;
		} catch {
			return undefined;
		}
	}

	// Reads the draft, trying again until there is an answer. Null also when
	// the card has gone meanwhile; callers check `alive`.
	async function readDraftSurely(): Promise<SceneDraftView | null> {
		const startedAt = Date.now();
		for (;;) {
			const found = await readDraft();
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

	function close() {
		return step(() => {
			draft = null;
			view = 'hidden';
			unread = false;
		});
	}

	function mirrorEdit() {
		saveError = edit?.error ?? '';
		changedElsewhere = edit?.conflict ?? false;
		// The card's copy of the draft follows each save, so it is never older
		// than what the box holds.
		if (edit && draft?.status === 'ready' && draft.textMd !== edit.saved) {
			draft = { ...draft, textMd: edit.saved };
		}
	}

	// Whether the card's draft is still the scene's draft, waiting as it was.
	function stillWaiting(fresh: SceneDraftView | null): boolean {
		return fresh !== null && fresh.id === draft?.id && fresh.status === draft.status;
	}
	function hasUnsavedText(): boolean {
		return edit !== null && text !== edit.saved;
	}
	// The card's draft was decided in another window: nothing more of it is
	// saved, and the card says so. Text the writer had not saved stays on the
	// card, read-only, until they close it.
	async function showGone(next: SceneDraftView | null) {
		const unsaved = hasUnsavedText() ? text : '';
		if (draft) dropDraftEdit(draft.id);
		edit = null;
		landing = null;
		await step(() => {
			gone = { text: unsaved, next };
			draft = null;
			error = '';
			view = 'gone';
		});
		onDecided?.();
		card?.focus();
	}
	async function closeGone() {
		const next = gone?.next ?? null;
		gone = null;
		if (next) {
			await step(() => show(next));
			card?.focus();
		} else {
			view = 'hidden';
			onClose?.();
		}
	}
	// Leaves the draft's edit state to save on its own.
	function releaseEdit() {
		if (!edit) return;
		releaseDraftEdit(edit);
		edit = null;
	}

	function show(found: SceneDraftView) {
		draft = found;
		sceneTitle = found.sceneTitle;
		if (found.status === 'ready') {
			// The writer's unsaved edits to this same draft stay in the box,
			// whether typed in this card or in one that has since gone.
			const held = draftEdit(found.id, found);
			if (held !== edit) {
				releaseEdit();
				edit = held;
				edit.onChange = mirrorEdit;
			}
			text = held.text;
		} else {
			releaseEdit();
			text = '';
		}
		mirrorEdit();
		error = '';
		view = 'draft';
		if (found.status === 'pending' || found.status === 'running') void follow(found);
	}

	// Waits for the draft to be written, then shows it. A draft with its own
	// job waits for that job; one of a chapter's is ready before its job ends,
	// so it is read again every few seconds instead.
	let followingId: string | null = null;
	async function follow(found: SceneDraftView) {
		if (followingId === found.id) return;
		followingId = found.id;
		try {
			const startedAt = Date.now();
			let latest: SceneDraftView | null = found;
			if (!found.inChapterRun && found.jobId) {
				await followSceneDraft({ jobId: found.jobId, storyId, sceneId, label: sceneLabel(found) });
				if (!alive || draft?.id !== found.id) return;
				latest = await readDraftSurely();
			}
			while (
				alive &&
				draft?.id === found.id &&
				latest?.id === found.id &&
				(latest.status === 'pending' || latest.status === 'running')
			) {
				await pollPause(startedAt);
				if (!alive || draft?.id !== found.id) return;
				latest = await readDraftSurely();
			}
			if (!alive || draft?.id !== found.id) return;
			// Stopped, or discarded elsewhere: nothing left to show.
			if (!latest || latest.id !== found.id) {
				await close();
				return;
			}
			const settled = latest;
			await step(() => show(settled));
			await reveal();
		} finally {
			if (followingId === found.id) followingId = null;
		}
	}

	function sceneLabel(found: { sceneTitle: string | null }) {
		return found.sceneTitle ? `"${found.sceneTitle}"` : 'this scene';
	}

	async function reveal() {
		await tick();
		card?.scrollIntoView({ block: 'nearest' });
	}

	// Opens the brief form with what the scene suggests, or with the brief of a
	// draft that failed, to try again.
	async function openForm(typed: string, from?: SceneDraftView) {
		counts += 1;
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

	// The open form is remembered as it is typed.
	$effect(() => {
		if (view === 'form') keepDraftForm('scene', sceneId, { brief, targetWords, pov, sceneTitle });
	});

	onMount(() => {
		const open = canDraft ? readDraftForm('scene', sceneId, parseOpenForm) : undefined;
		if (open) {
			({ brief, targetWords, pov, sceneTitle } = open);
			view = 'form';
		}
		void readDraftSurely().then((found) => {
			if (!alive || !found) return;
			// A form open to try a failed draft again keeps that draft behind it;
			// any other draft is what there is to decide.
			if (view === 'form' && found.status === 'failed') draft ??= found;
			else if (view === 'hidden' || view === 'form') {
				dropDraftForm('scene', sceneId);
				show(found);
			}
		});
		return () => {
			alive = false;
			// Edits not yet saved are sent now; the save outlives the card.
			releaseEdit();
		};
	});

	// The writer asked to draft this scene. A draft already there shows instead.
	let handled: { brief: string } | null = null;
	$effect(() => {
		const asked = request;
		if (!asked || asked === handled) return;
		handled = asked;
		onRequestTaken?.();
		void (async () => {
			// After the mount, which may have brought back a form left open.
			await tick();
			if (!alive) return;
			// A form already open keeps what is typed in it. Words that came with
			// the request (a typed "/draft ...") replace the brief; none leave it.
			if (view === 'form' && canDraft && !asked.showOnly) {
				if (asked.brief) {
					brief = asked.brief;
					estimate = null;
				}
				await reveal();
				briefEl?.focus();
				return;
			}
			if (view === 'gone') {
				await reveal();
				card?.focus();
				return;
			}
			// A draft already in the box stays as the writer has it: it is brought
			// into view, not shown again from an older copy. It is read again only
			// to see that it still waits; one decided in another window meanwhile
			// must not stand in the way of what was asked.
			let found: SceneDraftView | null;
			if (view === 'draft' && draft?.status === 'ready') {
				const fresh = await readDraftSurely();
				if (!alive) return;
				if (stillWaiting(fresh)) {
					await reveal();
					card?.focus();
					return;
				}
				if (hasUnsavedText()) {
					await showGone(fresh);
					return;
				}
				dropDraftEdit(draft.id);
				edit = null;
				draft = null;
				view = 'hidden';
				onDecided?.();
				found = fresh;
			} else found = draft ?? (await readDraftSurely());
			if (!alive) return;
			if (found) {
				show(found);
				await reveal();
				card?.focus();
			} else if (!asked.showOnly && canDraft) await openForm(asked.brief);
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
	// The form's one main button: it counts the cost, then starts the draft.
	// The start waits until the cost has been on screen for a moment.
	const confirmed = $derived(estimate !== null && !estimate.overCap);
	const guard = createConfirmGuard();
	function pressMain(event: MouseEvent) {
		if (!confirmed) void checkCost();
		else if (guard.allows(event)) void run();
	}

	// Counts what the draft would send before anything runs. Counts are
	// numbered: one that comes back after the form was opened again, or for a
	// form that has changed, is the cost of something else.
	let counts = 0;
	async function checkCost() {
		if (!formReady || working) return;
		working = true;
		error = '';
		estimate = null;
		const mine = ++counts;
		const counting = JSON.stringify(formBody());
		try {
			const response = await fetch('/api/assistant/draft', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...formBody(), estimate: true })
			});
			if (response.ok) {
				const counted = (await response.json()) as SceneDraftEstimate;
				if (mine === counts && view === 'form' && JSON.stringify(formBody()) === counting) {
					estimate = counted;
					guard.shown();
				}
			} else error = await apiErrorMessage(response, 'The Assistant could not count the draft.');
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
		// Before anything else: the card may have gone, and the form must not
		// come back for a draft that was started.
		if (started.ok) dropDraftForm('scene', sceneId);
		if (!alive) return;
		working = false;
		if (!started.ok) error = started.message;
		// On a refusal the scene may have a draft from another window by now.
		const found = started.ok ? await readDraftSurely() : await readDraft();
		if (!alive) return;
		const refused = started.ok ? '' : error;
		if (found) {
			await step(() => show(found));
			error = refused;
		} else if (started.ok) await close();
	}

	// The writer typed in the draft: it is saved a moment after they stop, when
	// they leave the box, and when the page is hidden or left.
	function edited() {
		if (!edit) return;
		edit.text = text;
		edit.autosave.schedule();
	}

	// Takes the draft as it is stored now, over this card's copy.
	async function loadCurrent() {
		error = '';
		const fresh = await readDraft();
		if (!alive) return;
		if (fresh === undefined) {
			error = 'Could not load the current text. Check your connection and try again.';
			return;
		}
		if (!edit || !stillWaiting(fresh)) {
			// Kept or discarded elsewhere: there is nothing to load.
			await showGone(fresh);
			return;
		}
		adoptStored(edit, fresh!);
		draft = fresh;
		text = edit.text;
		error = '';
	}

	async function land(action: 'fill' | 'add') {
		if (!draft || !edit || landing || !text.trim()) return;
		const id = draft.id;
		const held = edit;
		landing = action;
		error = '';
		// Saved first, so a late save cannot arrive after the draft is decided,
		// and so a copy that has fallen behind another window is caught here.
		held.text = text;
		await held.autosave.flush();
		let failed: string | null = held.conflict ? DRAFT_CHANGED_ELSEWHERE : null;
		// Keeping the draft carries the text as it stands, in case that save did
		// not get through.
		failed ??= await onLand(id, action, text, draftBaseHashes(held));
		// Adding a scene opens it, which takes this card away: say so first.
		if (!failed) {
			dropDraftEdit(id);
			onDecided?.();
			onClose?.();
		}
		if (!alive) return;
		landing = null;
		if (failed) {
			if (failed === DRAFT_CHANGED_ELSEWHERE) {
				held.conflict = true;
				held.error = failed;
				mirrorEdit();
			} else error = failed;
			// The scene may have gained text, so Fill may no longer be offered;
			// or the draft was decided in another window.
			const fresh = await readDraft();
			if (!alive) return;
			if (fresh !== undefined && !stillWaiting(fresh)) {
				await showGone(fresh);
				return;
			}
			if (fresh) draft = { ...fresh, textMd: held.saved };
			await tick();
			card?.focus();
			return;
		}
		edit = null;
		draft = null;
		view = 'hidden';
	}

	async function discard() {
		if (!draft || landing) return;
		const id = draft.id;
		landing = 'discard';
		error = '';
		const result = await post(
			`/api/assistant/draft/${id}`,
			{ action: 'discard' },
			'Could not discard the draft.'
		);
		if (result.ok) {
			dropDraftEdit(id);
			onDecided?.();
		}
		if (!alive) return;
		landing = null;
		if (!result.ok) {
			// Kept or discarded in another window already.
			const fresh = await readDraft();
			if (!alive) return;
			if (fresh !== undefined && (!fresh || fresh.id !== id)) {
				await showGone(fresh);
				return;
			}
			error = result.message;
			await tick();
			card?.focus();
			return;
		}
		edit = null;
		draft = null;
		view = 'hidden';
		onClose?.();
	}

	function cancelForm() {
		dropDraftForm('scene', sceneId);
		estimate = null;
		error = '';
		// Back to the failed draft the form was opened from, when there is one.
		view = draft ? 'draft' : 'hidden';
		if (view === 'hidden') onClose?.();
		else void tick().then(() => card?.focus());
	}
</script>

{#if view !== 'hidden'}
	<div
		class="assist-card assist-card-stack"
		bind:this={card}
		role="group"
		aria-label="Scene draft"
		tabindex="-1"
	>
		<div class="assist-card-head">
			<Icon name="sparkles" size={13} />
			{heading}
			{label}
		</div>

		{#if view === 'loading'}
			<p class="assist-card-note">Loading...</p>
		{:else if view === 'gone' && gone}
			<p class="assist-card-note" role="status">{GONE_MESSAGE}</p>
			{#if gone.text}
				<div class="field">
					<label for="draft-gone-text">
						What you had typed here was not saved. Copy anything you want to keep.
					</label>
					<textarea
						id="draft-gone-text"
						class="textarea draft-text"
						rows="8"
						readonly
						value={gone.text}></textarea>
				</div>
			{/if}
			<div class="assist-card-actions">
				<button class="btn" type="button" onclick={closeGone}>Close</button>
			</div>
		{:else if view === 'form'}
			<div class="field">
				<label for="draft-brief">What happens in this scene</label>
				<textarea
					id="draft-brief"
					class="textarea"
					rows="4"
					maxlength={MAX_DRAFT_BRIEF_CHARS}
					readonly={working}
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
						readonly={working}
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
						readonly={working}
						bind:value={pov}
						oninput={() => (estimate = null)}
					/>
				</div>
			</div>
			{#if estimate}
				<DraftCostNote {estimate} capAdvice={sceneCapAdvice(estimate.mayThink)} />
			{/if}
			<FormStatus block {error} />
			<div class="assist-card-actions">
				<!-- One button for both steps, so the keyboard stays on it. It is
				     not disabled while it works, which would drop focus; a second
				     press right after the cost shows does not start the draft. -->
				<button
					class="btn btn-primary"
					type="button"
					disabled={!formReady}
					aria-busy={working}
					onclick={pressMain}
					onkeydown={guard.keydown}
				>
					{#if confirmed}
						{working ? 'Starting...' : 'Draft the scene'}
					{:else}
						{working ? 'Counting...' : 'Check the cost'}
					{/if}
				</button>
				<button class="btn" type="button" onclick={cancelForm}>Cancel</button>
			</div>
			<p class="field-hint">
				The draft is shown here first. Your scene stays as it is until you choose what to do with
				it.
			</p>
		{:else if draft && running}
			<p class="assist-card-note" role="status">
				{#if draft.inChapterRun}
					This scene is part of a chapter the Assistant is drafting in the background. Its draft
					shows here when it is written.
				{:else}
					The Assistant is writing this draft in the background. You can keep working, and you will
					be notified when it is ready.
				{/if}
			</p>
			{#if unread}
				<p class="assist-card-note" role="status">Could not check on this draft. Trying again.</p>
			{/if}
			{#if !draft.inChapterRun}
				<FormStatus block error={job?.stopError} />
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
			{/if}
		{:else if draft?.status === 'ready'}
			{#if draft.note}
				<p class="assist-card-note">{draft.note}</p>
			{/if}
			<div class="field">
				<label for="draft-text">Read it, and change anything you like before keeping it</label>
				<textarea
					id="draft-text"
					class="textarea draft-text"
					rows="12"
					readonly={landing !== null}
					bind:value={text}
					oninput={edited}
					onblur={() => edit?.autosave.flushSoon()}></textarea>
			</div>
			<FormStatus block error={error || saveError} />
			{#if changedElsewhere}
				<div class="assist-card-actions">
					<button class="btn" type="button" disabled={landing !== null} onclick={loadCurrent}>
						Load the current text
					</button>
				</div>
				<p class="field-hint">
					Loading it replaces what is in the box above with the draft as it was last saved.
				</p>
			{/if}
			<div class="assist-card-actions">
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
			<p class="field-hint">
				{draft.sceneEmpty
					? 'Fill this scene puts the draft into the empty scene. The other choice adds it as a new scene.'
					: 'This scene already has text, so the draft is added as a new scene and your text stays as it is.'}
			</p>
		{:else if draft}
			<FormStatus block error={draft.note ?? 'The Assistant could not write this draft.'} />
			<FormStatus block {error} />
			<div class="assist-card-actions">
				{#if canDraft}
					<button
						class="btn btn-primary"
						type="button"
						disabled={landing !== null}
						onclick={() => draft && openForm('', draft)}
					>
						Try again
					</button>
				{/if}
				<button class="btn" type="button" disabled={landing !== null} onclick={discard}>
					Discard
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.draft-pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: var(--space-2);
	}
	.draft-text {
		font-family: var(--font-content);
		font-size: var(--text-prose-sm);
		line-height: 1.5;
	}
</style>
