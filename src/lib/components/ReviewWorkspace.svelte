<script lang="ts">
	import PaneResizer from '#lib/components/PaneResizer.svelte';
	import { withQuery } from '#lib/href';
	import { focusShownPane } from '#lib/pane-focus';
	import { tick, untrack } from 'svelte';
	import type { ResolvedPathname } from '$app/types';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { refreshAll } from '$app/navigation';
	import {
		dismissActivity,
		flashActivity,
		resolveActivity,
		startActivity
	} from '#lib/activity.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import SidebarSearch from './SidebarSearch.svelte';
	import StoryOutline from './StoryOutline.svelte';
	import ClearReviewsModal from './ClearReviewsModal.svelte';
	import ReviewDecideModal from './ReviewDecideModal.svelte';
	import StoryRowMenu, { type RowMenuState, type RowMenuTarget } from './StoryRowMenu.svelte';
	import ReviewSurface from './ReviewSurface.svelte';
	import ReviewEditor from './ReviewEditor.svelte';
	import ReviewPanel from './ReviewPanel.svelte';
	import PatternPass from './PatternPass.svelte';
	import type { Composer } from './ReviewPanel.svelte';
	import AssistantPanel, { type AssistantChatData } from './AssistantPanel.svelte';
	import type { MentionEntity } from '#lib/editor-mentions';
	import type { MarkVisibility } from '#lib/editor';
	import {
		anchorPos,
		patternEdits,
		patternQueue,
		pendingPatternCounts,
		suggestionInFilter,
		threadInFilter,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '#lib/review-ui';
	import type { SaveStatus } from './SceneEditor.svelte';
	import type { ViewItem } from './ViewMenu.svelte';
	import ModeSwitcher from './ModeSwitcher.svelte';
	import PanelStrip from './PanelStrip.svelte';
	import { activePanel, visiblePanels, type PanelId } from '#lib/panels';
	import { GUEST_MODE_NOTE, LEFT_PANE_LABEL, RIGHT_PANE_LABEL } from '#lib/chrome';
	import {
		duplicateScene as duplicateSceneAction,
		flushEditors,
		mergeScenes as mergeScenesAction,
		SAVE_FAILED
	} from '#lib/scene-actions';
	import { focusMode } from '#lib/focus-mode.svelte';
	import { openReviewModal } from '#lib/review-modal.svelte';

	let {
		chapters,
		scenes,
		trashedScenes = [],
		threads,
		suggestions,
		role,
		seenAt = '',
		storyId = null,
		storySlug = null,
		book = null,
		canSuggest = true,
		seg = null,
		entities = [],
		mentionMembers = [],
		mentionPins = {},
		entityHref = null,
		nonPrintingMarks = 'hidden',
		commandMarkers = 'shown',
		editorStyle,
		assistant = null,
		assistantChat = null,
		onSaveStatus = () => {}
	}: {
		chapters: { id: string; title: string | null }[];
		scenes: {
			id: string;
			chapterId: string | null;
			title: string | null;
			status?: string | null;
			bodyMd: string;
		}[];
		// The author's sidebar manages structure here too; the trash needs the list.
		trashedScenes?: { id: string; title: string | null; wordCount: number }[];
		threads: ReviewThread[];
		suggestions: ReviewSuggestion[];
		role: 'author' | 'guest';
		// When the author's page data was read; "Clear review notes" keeps
		// anything newer.
		seenAt?: string;
		// The owning story; the author's editable centre autosaves against it.
		storyId?: string | null;
		// The story slug, for the View dropdown's links to Preview and Print.
		storySlug?: string | null;
		// The book header above the outline (title plus universe); null hides it.
		book?: { title: string; subtitle: string | null } | null;
		canSuggest?: boolean;
		// The mode switcher links, shown on the author side only.
		seg?: { writeHref: ResolvedPathname; planHref: ResolvedPathname } | null;
		// Entity mention data for the centre's highlights and quick cards.
		entities?: MentionEntity[];
		mentionMembers?: string[];
		mentionPins?: Record<string, string>;
		entityHref?: ((entity: MentionEntity) => ResolvedPathname) | null;
		// The author editor's view toggles, persisted per user.
		nonPrintingMarks?: MarkVisibility;
		commandMarkers?: MarkVisibility;
		// The author's editor-appearance CSS variables for the editable centre;
		// unset on the guest page.
		editorStyle?: string;
		// Set on the author page when the Assistant tab is available for this
		// story (account-level on). surfacesEnabled adds the live surfaces: the
		// thread answers and the "Review with the Assistant" launcher, both off
		// when the story is muted. Never set on the guest page.
		assistant?: { name: string; surfacesEnabled: boolean; muted: boolean } | null;
		// The stored Assistant chats, seeding the Assistant tab.
		assistantChat?: AssistantChatData | null;
		// The author editor's autosave feedback, surfaced in the page's app bar.
		onSaveStatus?: (status: SaveStatus) => void;
	} = $props();

	// Scenes in reading order, each tagged with its chapter label, so the nav
	// and the centre header agree on where a scene sits.
	const orderedScenes = $derived.by(() => {
		const out: {
			id: string;
			chapterId: string | null;
			title: string | null;
			status?: string | null;
			bodyMd: string;
			chapterTitle: string;
		}[] = [];
		chapters.forEach((chapter, i) => {
			const label = chapter.title ?? `Chapter ${i + 1}`;
			for (const scene of scenes.filter((s) => s.chapterId === chapter.id)) {
				out.push({ ...scene, chapterTitle: label });
			}
		});
		for (const scene of scenes.filter((s) => s.chapterId === null)) {
			out.push({ ...scene, chapterTitle: 'Unfiled scenes' });
		}
		return out;
	});

	// Suggestion-linked threads render on their suggestion's card; everything
	// else (the nav counts, the centre marks, the panel's comment list) sees
	// only the standalone threads.
	const standaloneThreads = $derived(threads.filter((t) => !t.suggestionId));
	// Story-wide counts for the clear dialog.
	// Notes on scenes in the deleted list stay with those scenes.
	const liveSceneIds = $derived(new Set(scenes.map((scene) => scene.id)));
	const liveThreads = $derived(standaloneThreads.filter((t) => liveSceneIds.has(t.sceneId)));
	const liveSuggestions = $derived(suggestions.filter((s) => liveSceneIds.has(s.sceneId)));
	const finishedNotes = $derived(
		liveThreads.filter((t) => t.resolvedAt !== null).length +
			liveSuggestions.filter((s) => s.status !== 'pending').length
	);
	const totalNotes = $derived(liveThreads.length + liveSuggestions.length);
	let clearing = $state(false);
	// The review toolbar's dialog for deciding on several edits at once.
	let deciding = $state(false);
	const discussions = $derived(
		new Map(threads.filter((t) => t.suggestionId).map((t) => [t.suggestionId!, t]))
	);

	// Open items per scene for the outline badge, honoring the active filter and
	// counted the same way the right panel lists them, so the two always agree.
	const countByScene = $derived.by(() => {
		const m = new SvelteMap<string, number>();
		for (const t of standaloneThreads) {
			if (threadInFilter(t, filter)) m.set(t.sceneId, (m.get(t.sceneId) ?? 0) + 1);
		}
		for (const s of suggestions) {
			if (suggestionInFilter(s, filter)) m.set(s.sceneId, (m.get(s.sceneId) ?? 0) + 1);
		}
		return m;
	});

	// The Assistant answering in its own threads: POST the trigger, then pull
	// the fresh thread in. Failures stay quiet - the author's reply already
	// landed; the Assistant just has not answered.
	async function assistantReply(threadId: string) {
		try {
			await fetch('/api/assistant/review-reply', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ threadId })
			});
		} catch {
			// reported by the missing reply itself
		}
		await refreshAll();
	}

	let filter = $state<ReviewFilter>('all');
	let focusedId = $state<string | null>(null);
	// The author's live editor, so a confirmed accept can be folded into the
	// open document at once instead of waiting for the page data to reload
	// (an autosave in that window would overwrite the accepted text).
	let editorRef = $state<ReviewEditor>();
	let query = $state('');
	let composer = $state<Composer | null>(null);
	// On a narrow screen the three panes stack behind a tab bar; on desktop the
	// tab bar is hidden and all three show side by side.
	type PaneTab = 'nav' | 'read' | 'notes';
	let mobileTab = $state<PaneTab>('read');
	const paneEls: Partial<Record<PaneTab, HTMLElement>> = {};
	let paneTabsEl = $state<HTMLElement>();
	async function showPane(tab: PaneTab) {
		if (mobileTab === tab) return;
		mobileTab = tab;
		await tick();
		focusShownPane(paneTabsEl, paneEls[tab]);
	}
	// The right pane's panels. You are not editing here, so there is no History
	// and no Reference: Comments is what this text has, and the Assistant reads
	// it when the author has one. A reviewer gets Comments alone, so their pane
	// wears the panel's title instead of a one-segment strip.
	let chosenPanel = $state<PanelId | null>('comments');
	// The Assistant tab is the author's own page, with the Assistant turned on at
	// the account level. surfacesEnabled is the stricter gate (not muted) for the
	// thread answers and the review launcher.
	const assistantTab = $derived(role === 'author' && Boolean(storyId) && assistant !== null);
	const assistantSurfaces = $derived(assistant?.surfacesEnabled ?? false);

	// Grounded starter prompts for an empty Assistant conversation, named after
	// the story's known characters; generic fallbacks when the cast is empty.
	const assistantSuggestions = $derived.by(() => {
		const characters = entities.filter((e) => e.type === 'character').map((e) => e.name);
		const title = book?.title || 'this story';
		const prompts: string[] = [];
		if (characters[0]) prompts.push(`What's at stake for ${characters[0]} in ${title}?`);
		prompts.push('What should I look at in this review?');
		if (characters[1]) prompts.push(`Is ${characters[1]}'s arc consistent so far?`);
		else prompts.push('Catch me up on the story so far.');
		return prompts;
	});

	// Default to the first scene that has open activity, else the first scene.
	const firstActive = $derived(
		orderedScenes.find(
			(s) =>
				standaloneThreads.some((t) => t.sceneId === s.id && t.resolvedAt === null) ||
				suggestions.some((su) => su.sceneId === s.id && su.status === 'pending')
		)?.id
	);
	// The selected scene starts from the URL's ?scene, which a sidebar management
	// action's redirect carries the open scene in. After that it is local state:
	// an in-page scene click (or a duplicate/merge) sets it directly. Because it
	// is plain state, a data refresh (refreshAll leaves the URL alone) keeps
	// that choice - a writable $derived would recompute on the refresh and lose
	// it. The effect re-syncs only when the URL's ?scene actually changes (a real
	// navigation or a management redirect), not on every refresh.
	let chosenSceneId = $state(page.url.searchParams.get('scene'));
	let lastUrlScene = page.url.searchParams.get('scene');
	$effect(() => {
		const urlScene = page.url.searchParams.get('scene');
		if (urlScene !== lastUrlScene) {
			lastUrlScene = urlScene;
			chosenSceneId = urlScene;
		}
	});
	const selectedSceneId = $derived(
		(chosenSceneId && orderedScenes.some((s) => s.id === chosenSceneId) ? chosenSceneId : null) ??
			firstActive ??
			orderedScenes[0]?.id ??
			''
	);
	const selectedScene = $derived(orderedScenes.find((s) => s.id === selectedSceneId));

	// Pin the scene the moment one is shown. Without this, "first scene with
	// activity" keeps re-deciding as items are worked: accepting or resolving the
	// last note in a scene would yank the view to the next active scene, away
	// from the change the author may still want to edit.
	$effect(() => {
		if (chosenSceneId === null && selectedSceneId) chosenSceneId = selectedSceneId;
	});

	const sceneThreads = $derived(standaloneThreads.filter((t) => t.sceneId === selectedSceneId));
	const sceneSuggestions = $derived(suggestions.filter((s) => s.sceneId === selectedSceneId));
	// The open scene's pending edits in reading order, as the panel lists them.
	const pendingHere = $derived(
		sceneSuggestions
			.filter((s) => s.status === 'pending')
			.sort((a, b) => anchorPos(a.anchor) - anchorPos(b.anchor))
	);

	// The View dropdown for the editable centre, the same control as the Write
	// toolbar: Edit (here), Preview and Print (the export views), and a
	// distraction-free Focus that hides the side panes.
	const viewMenu = $derived<ViewItem[]>(
		storySlug
			? [
					{ id: 'edit', label: 'Edit', icon: 'pencil', current: true },
					{
						id: 'preview',
						label: 'Preview',
						icon: 'book',
						href: withQuery(resolve('/stories/[id]', { id: storySlug }), {
							view: 'preview',
							scene: selectedSceneId
						})
					},
					{ id: 'focus', label: 'Focus', icon: 'expand', onSelect: () => (focusMode.on = true) },
					{
						id: 'print',
						label: 'Print',
						icon: 'print',
						href: resolve('/stories/[id]/print', { id: storySlug })
					}
				]
			: []
	);
	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && focusMode.on) focusMode.on = false;
	}
	// Open items in the selected scene, surfaced as a badge on the Notes tab.
	const sceneOpen = $derived(
		sceneThreads.filter((t) => t.resolvedAt === null).length +
			sceneSuggestions.filter((s) => s.status === 'pending').length
	);

	const panels = $derived(visiblePanels({ comments: sceneOpen, assistant: assistantTab }));
	const rightPanel = $derived(activePanel(panels, chosenPanel));

	function selectScene(id: string) {
		if (id !== selectedSceneId) {
			chosenSceneId = id;
			composer = null;
		}
	}

	function navSelectScene(sceneId: string) {
		selectScene(sceneId);
		// Picking a scene from the outline shows the manuscript on mobile.
		void showPane('read');
	}

	// The author manages structure from the review sidebar, the same outline and
	// row menu as Write. The guest reviewer never gets this.
	const manage = $derived(role === 'author' && Boolean(storyId));
	let rowMenu = $state<RowMenuState | null>(null);
	let rowMenuTrigger: HTMLElement | null = null;
	let renamingChapterId = $state<string | null>(null);
	const mergeSelection = new SvelteSet<string>();

	function openRowMenu(event: MouseEvent, target: RowMenuTarget) {
		event.preventDefault();
		rowMenuTrigger = event.currentTarget as HTMLElement;
		// A keyboard-invoked context menu (Shift+F10) reports (0,0); anchor it to
		// the row instead of dropping it in the corner.
		if (event.clientX === 0 && event.clientY === 0) {
			const rect = rowMenuTrigger.getBoundingClientRect();
			rowMenu = { x: rect.left, y: rect.bottom, target };
		} else {
			rowMenu = { x: event.clientX, y: event.clientY, target };
		}
	}

	function closeRowMenu(refocus = false) {
		rowMenu = null;
		if (refocus) rowMenuTrigger?.focus();
		rowMenuTrigger = null;
	}

	// The row menu's "Review with the Assistant..."; back on the row first, so
	// closing the modal returns focus there.
	function openReviewFor(request: { sceneId?: string; chapterId?: string }) {
		closeRowMenu(true);
		openReviewModal({
			level: request.sceneId ? 'scene' : 'chapter',
			sceneId: request.sceneId,
			chapterId: request.chapterId
		});
	}

	// Set while a merge or duplicate saves and then replaces the open scene, as
	// on the Write page: the editor takes no typing, since words typed then
	// would land after the save and vanish with the remount. A count, so
	// overlapping actions do not unpause each other early.
	let pauseDepth = $state(0);
	const typingPaused = $derived(pauseDepth > 0);
	// Bumped after a merge or duplicate, so the editor remounts on the stored
	// text instead of keeping (and later saving) what it had.
	let editorNonce = $state(0);
	async function pauseTypingWhile(work: () => Promise<void>) {
		pauseDepth++;
		try {
			await work();
		} finally {
			pauseDepth--;
		}
	}
	// Both actions read the stored text, so the open editor's pending save
	// lands first; a failed save stops the action.
	const flushEditor = () => flushEditors(editorRef ? [editorRef] : []);
	// For a card's accept, which has no place of its own to report a failure.
	async function flushBeforeAccept(): Promise<boolean> {
		if (await flushEditor()) return true;
		alert(SAVE_FAILED);
		return false;
	}
	// A new scene (a duplicate) is picked only once the refresh has loaded
	// it: picked before, the selection falls back to another scene for a
	// moment and the editor mounts twice. One that already exists (a merge's
	// survivor) is picked first, so the refresh does not fall back off a
	// scene the merge trashed.
	async function openChangedScene(sceneId: string) {
		if (orderedScenes.some((scene) => scene.id === sceneId)) chosenSceneId = sceneId;
		// The editor remounts even when the reload fails, so it never keeps
		// (and later saves) the text from before the merge or duplicate.
		try {
			await refreshAll();
		} catch {
			flashActivity(
				'failed',
				'Could not reload the story',
				'The change was made. Reload the page to see it.'
			);
		} finally {
			chosenSceneId = sceneId;
			editorNonce++;
		}
	}

	// Copies a scene in full directly after itself; the new scene becomes the one
	// under review.
	async function duplicateScene(sceneId: string) {
		rowMenu = null;
		if (!storyId || typingPaused) return;
		const id = storyId;
		await pauseTypingWhile(async () => {
			if (!(await flushEditor())) return alert(SAVE_FAILED);
			const result = await duplicateSceneAction(id, sceneId);
			if (!result.ok) return alert(result.message);
			await openChangedScene(result.newSceneId);
		});
	}

	// Joins the picked scenes in story order; the survivor becomes the open scene.
	async function mergeSelectedScenes() {
		rowMenu = null;
		if (!storyId || typingPaused) return;
		const id = storyId;
		await pauseTypingWhile(async () => {
			if (!(await flushEditor())) return alert(SAVE_FAILED);
			const result = await mergeScenesAction(id, [...mergeSelection]);
			if (!result.ok) return alert(result.message);
			mergeSelection.clear();
			await openChangedScene(result.targetSceneId);
		});
	}

	// Clicking a card jumps to its passage; clicking a mark jumps to its note.
	// On mobile that means switching to the pane the target lives in.
	function focusFromPanel(id: string | null) {
		focusedId = id;
		void showPane('read');
	}
	function focusFromSurface(id: string | null) {
		focusedId = id;
		void showPane('notes');
	}

	function openComposer(c: Composer) {
		composer = c;
		// The composer lives in the right panel; show it on mobile.
		void showPane('notes');
	}

	// ---- the guided pass over an Assistant pattern note ----
	// Works through the note's pending edits in reading order, one at a time.
	// done holds what this pass accepted or skipped (a skip leaves the edit
	// pending). currentId keeps the step on screen steady while the queue
	// changes around it.
	const patternCounts = $derived(pendingPatternCounts(liveSuggestions));
	let pass = $state<{
		threadId: string;
		done: SvelteSet<string>;
		// The ones of done the writer skipped.
		skipped: SvelteSet<string>;
		currentId: string | null;
	} | null>(null);
	const passNote = $derived(pass ? (threads.find((t) => t.id === pass!.threadId) ?? null) : null);
	const passEdits = $derived(
		pass
			? patternEdits(
					liveSuggestions,
					pass.threadId,
					orderedScenes.map((scene) => scene.id)
				)
			: []
	);
	const passOpen = $derived(
		pass ? passEdits.filter((s) => s.status === 'pending' && !pass!.done.has(s.id)) : []
	);
	const passStep = $derived(
		pass ? (passOpen.find((s) => s.id === pass!.currentId) ?? passOpen[0] ?? null) : null
	);
	const passScene = $derived(
		passStep ? (orderedScenes.find((scene) => scene.id === passStep.sceneId) ?? null) : null
	);

	function startPass(threadId: string) {
		const queue = patternQueue(
			liveSuggestions,
			threadId,
			orderedScenes.map((scene) => scene.id)
		);
		pass = {
			threadId,
			done: new SvelteSet(),
			skipped: new SvelteSet(),
			currentId: queue[0]?.id ?? null
		};
		composer = null;
		chosenPanel = 'comments';
	}

	// A link from an outside app (?pass=<note id>) opens the pass on that note
	// straight away. Asked once, when the page first has the note; a note that
	// is gone or has nothing left to decide just shows the review as usual.
	let passAsked = false;
	$effect(() => {
		if (passAsked || role !== 'author' || !storyId) return;
		passAsked = true;
		const asked = page.url.searchParams.get('pass');
		if (!asked) return;
		untrack(() => {
			const note = liveThreads.find((thread) => thread.id === asked);
			if (note && (patternCounts.get(asked) ?? 0) > 0) startPass(asked);
		});
	});

	// Each new step opens its scene and points the manuscript at the change.
	// Only a new step does: the writer may open another scene mid-pass to read
	// around, and is not pulled back until the next step. Nor is a writer
	// typing in the manuscript when a step turns up on its own (a follow-up
	// arriving at the end of the pass): the step shows in the pane only.
	let lastStepId: string | null = null;
	$effect(() => {
		const step = passStep;
		if (!pass || !step) {
			lastStepId = null;
			return;
		}
		if (step.id === lastStepId) return;
		lastStepId = step.id;
		untrack(() => {
			if (!pass) return;
			pass.currentId = step.id;
			if (document.activeElement?.closest('.review-edit')) return;
			if (step.sceneId !== selectedSceneId && orderedScenes.some((s) => s.id === step.sceneId)) {
				selectScene(step.sceneId);
			}
			focusedId = step.id;
		});
	});
	// The note was cleared or deleted under the pass: nothing left to work.
	$effect(() => {
		if (pass && !passNote) pass = null;
	});

	function passAccepted(
		id: string,
		accepted: { bodyMd: string; baseHash: string } | null,
		replacement: string | undefined
	) {
		// Folded into the open editor even if the pass was stopped meanwhile:
		// the server has already applied it.
		editorRef?.applyAccepted(
			[id],
			accepted,
			replacement === undefined ? {} : { [id]: replacement }
		);
		if (!pass) return;
		pass.done.add(id);
		if (assistantSurfaces) void rereadAfter(id);
	}

	// The Assistant re-reads the changed paragraph and its neighbours and may
	// stage one follow-up edit on the same note. A follow-up joins the back of
	// the queue (patternEdits), so the pass only moves forward. Each re-read
	// shows as a card in the corner rather than in the pane, so the step being
	// read does not move when one starts or ends.
	// Not state: only read to dismiss the cards.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const rereadCards = new Set<number>();
	function clearRereadCards() {
		for (const id of rereadCards) dismissActivity(id);
		rereadCards.clear();
	}
	// A stopped pass, or a page left, takes its re-read cards with it.
	$effect(() => {
		if (!pass) untrack(clearRereadCards);
	});
	let destroyed = false;
	$effect(() => () => {
		destroyed = true;
		clearRereadCards();
	});
	// Re-reads still running, by note. Kept outside the pass, so a pass stopped
	// and started again on the same note still waits for the earlier ones.
	const rereading = new SvelteMap<string, number>();
	function countRereading(threadId: string, by: number) {
		const left = (rereading.get(threadId) ?? 0) + by;
		if (left > 0) rereading.set(threadId, left);
		else rereading.delete(threadId);
	}

	async function rereadAfter(suggestionId: string) {
		const current = pass;
		if (!current) return;
		const threadId = current.threadId;
		const card = startActivity('Re-reading the last change');
		rereadCards.add(card);
		countRereading(threadId, 1);
		let ok: boolean;
		// Whether the server answered at all; a request that never got through
		// staged nothing, so there is nothing to load.
		let answered = false;
		let ids: string[] = [];
		try {
			const response = await fetch('/api/assistant/pattern-reread', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ suggestionId })
			});
			answered = true;
			ok = response.ok;
			if (ok) ids = ((await response.json()) as { ids?: string[] }).ids ?? [];
		} catch {
			ok = false;
		}
		try {
			if (destroyed) return;
			// Refreshed even when the pass was stopped, so a pass started again
			// later sees the follow-up, and after a failed answer too: a re-read
			// that timed out may still have staged one. The count drops only after
			// the refresh, so the end of the pass is not offered in between.
			if (answered) await refreshAll();
		} catch {
			ok = false;
		} finally {
			countRereading(threadId, -1);
			rereadCards.delete(card);
		}
		if (destroyed || pass !== current) {
			dismissActivity(card);
			return;
		}
		if (!ok) resolveActivity(card, { state: 'failed', label: 'Could not re-read the last change' });
		else if (ids.length > 0) resolveActivity(card, { state: 'done', label: 'Follow-up added' });
		else dismissActivity(card);
	}

	function startComment(sel: { start: number; end: number; text: string }) {
		openComposer({
			sceneId: selectedSceneId,
			start: sel.start,
			end: sel.end,
			text: sel.text,
			mode: 'comment',
			anchored: true
		});
	}
	function startSuggest(sel: { start: number; end: number; text: string }) {
		openComposer({
			sceneId: selectedSceneId,
			start: sel.start,
			end: sel.end,
			text: sel.text,
			mode: 'suggest',
			anchored: true
		});
	}
	function startSceneComment() {
		openComposer({
			sceneId: selectedSceneId,
			start: 0,
			end: 0,
			text: '',
			mode: 'comment',
			anchored: false
		});
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="review-shell">
	<nav class="seg full pane-tabs" aria-label="Review sections" bind:this={paneTabsEl}>
		<button
			class="seg-btn"
			class:active={mobileTab === 'nav'}
			aria-pressed={mobileTab === 'nav'}
			type="button"
			onclick={() => (mobileTab = 'nav')}
		>
			Scenes
		</button>
		<button
			class="seg-btn"
			class:active={mobileTab === 'read'}
			aria-pressed={mobileTab === 'read'}
			type="button"
			onclick={() => (mobileTab = 'read')}
		>
			Manuscript
		</button>
		<button
			class="seg-btn"
			class:active={mobileTab === 'notes'}
			aria-pressed={mobileTab === 'notes'}
			type="button"
			onclick={() => (mobileTab = 'notes')}
		>
			Notes{#if sceneOpen > 0}<span class="seg-count">{sceneOpen}</span>{/if}
		</button>
	</nav>
	<div class="body" data-mtab={mobileTab}>
		<aside class="pane left" aria-label={LEFT_PANE_LABEL} tabindex="-1" bind:this={paneEls.nav}>
			<PaneResizer side="left" />
			<div class="left-head">
				<!-- A reviewer stays in review mode; the other views are out of reach. -->
				<ModeSwitcher
					active="review"
					hrefs={seg
						? { write: seg.writeHref, plan: seg.planHref }
						: { write: 'disabled', plan: 'disabled' }}
					note={seg ? undefined : GUEST_MODE_NOTE}
					storyId={storyId ?? undefined}
				/>
				<SidebarSearch bind:query placeholder="Filter chapters and scenes..." />
			</div>
			<div class="left-scroll">
				{#snippet reviewCount(scene: { id: string })}
					{@const n = countByScene.get(scene.id) ?? 0}
					{#if n > 0}<span class="scene-count">{n}</span>{/if}
				{/snippet}
				<StoryOutline
					story={{ id: storyId ?? '', title: book?.title ?? '' }}
					universeName={book?.subtitle ?? ''}
					{chapters}
					scenes={orderedScenes}
					trashedScenes={manage ? trashedScenes : []}
					{selectedSceneId}
					{query}
					canManage={manage}
					onSelectScene={navSelectScene}
					sceneMeta={reviewCount}
					onOpenRowMenu={openRowMenu}
					{mergeSelection}
					bind:renamingChapterId
				/>
			</div>
		</aside>

		<main id="main" class="pane center" tabindex="-1" bind:this={paneEls.read}>
			{#if !selectedScene}
				<h1 class="visually-hidden">{book?.title ?? 'Review'} - Review</h1>
			{/if}
			{#if selectedScene}
				{#key `${selectedScene.id}:${editorNonce}`}
					{#if role === 'author' && storyId}
						<!-- The author reads and edits the manuscript in place: accept a
						     suggestion, then build on it. -->
						<ReviewEditor
							bind:this={editorRef}
							scene={selectedScene}
							chapterTitle={selectedScene.chapterTitle}
							threads={sceneThreads}
							suggestions={sceneSuggestions}
							{filter}
							{focusedId}
							setFocused={focusFromSurface}
							{canSuggest}
							{entities}
							{mentionMembers}
							{mentionPins}
							{entityHref}
							{nonPrintingMarks}
							{commandMarkers}
							{editorStyle}
							{viewMenu}
							onStartComment={startComment}
							onStartSuggest={startSuggest}
							onStatus={onSaveStatus}
							paused={typingPaused}
						/>
					{:else}
						<ReviewSurface
							scene={selectedScene}
							chapterTitle={selectedScene.chapterTitle}
							threads={sceneThreads}
							suggestions={sceneSuggestions}
							{filter}
							{focusedId}
							setFocused={focusFromSurface}
							{canSuggest}
							{entities}
							{mentionMembers}
							{mentionPins}
							{entityHref}
							onStartComment={startComment}
							onStartSuggest={startSuggest}
						/>
					{/if}
				{/key}
			{:else}
				<div class="empty-state">
					<p class="empty-state-text">This story has no scenes to review yet.</p>
				</div>
			{/if}
		</main>

		<aside class="pane right" aria-label={RIGHT_PANE_LABEL} tabindex="-1" bind:this={paneEls.notes}>
			<PaneResizer side="right" />
			<!-- One panel invocation, two shapes of pane: with the Assistant the strip
			     is a real tablist, without it the pane is just the Comments panel,
			     which carries its own title. The props must not drift between the
			     two - dropping onAccepted here once cost the author's live accept. -->
			{#snippet commentsPanel()}
				{#if pass && passNote}
					<PatternPass
						note={passNote}
						edits={passEdits}
						step={passStep}
						scene={passScene}
						sceneOf={(id) => orderedScenes.find((scene) => scene.id === id) ?? null}
						skipped={(id) => pass?.skipped.has(id) ?? false}
						accepted={(id) => (pass?.done.has(id) && !pass.skipped.has(id)) ?? false}
						rereading={rereading.has(pass.threadId)}
						position={pass.done.size + 1}
						total={pass.done.size + passOpen.length}
						onAccepted={passAccepted}
						onSkip={(id) => {
							pass?.skipped.add(id);
							pass?.done.add(id);
						}}
						beforeAccept={flushEditor}
						onStop={() => (pass = null)}
					/>
				{:else if selectedScene}
					<ReviewPanel
						scene={selectedScene}
						threads={sceneThreads}
						suggestions={sceneSuggestions}
						{discussions}
						{filter}
						setFilter={(f) => (filter = f)}
						{focusedId}
						setFocused={focusFromPanel}
						{role}
						{canSuggest}
						{composer}
						onCloseComposer={() => (composer = null)}
						onStartSceneComment={startSceneComment}
						onAccepted={role === 'author'
							? (ids, accepted) => editorRef?.applyAccepted(ids, accepted)
							: null}
						beforeAccept={role === 'author' ? flushBeforeAccept : null}
						assistant={assistantSurfaces ? { name: assistant?.name ?? 'Assistant' } : null}
						onAssistantReply={assistantSurfaces ? assistantReply : null}
						onClearReviews={role === 'author' && storyId && totalNotes > 0
							? () => (clearing = true)
							: null}
						onDecideTogether={role === 'author' && storyId ? () => (deciding = true) : null}
						{patternCounts}
						onWorkThrough={role === 'author' && storyId ? startPass : null}
					/>
				{/if}
			{/snippet}
			{#if assistantTab}
				<PanelStrip
					{panels}
					active={rightPanel ?? 'comments'}
					onSelect={(id) => (chosenPanel = id)}
					label="Panels about this scene"
				>
					{#snippet panel(id)}
						{#if id === 'assistant'}
							{#if assistantSurfaces}
								<button
									class="rv-review-btn"
									type="button"
									onclick={() =>
										openReviewModal(
											selectedSceneId
												? { level: 'scene', sceneId: selectedSceneId }
												: { level: 'story' }
										)}
								>
									<Icon name="sparkles" size={13} /> Review with the Assistant
								</button>
							{/if}
							<div class="rv-assistant-wrap">
								<!-- Remount on a new scope: the panel seeds its chats once. -->
								{#key storyId}
									<AssistantPanel
										scope={{ storyId: storyId ?? '', storyTitle: book?.title ?? '' }}
										sceneId={selectedSceneId || null}
										name={assistant?.name ?? 'Assistant'}
										muted={assistant?.muted ?? false}
										suggestions={assistantSuggestions}
										chat={assistantChat}
									/>
								{/key}
							</div>
						{:else}
							{@render commentsPanel()}
						{/if}
					{/snippet}
				</PanelStrip>
			{:else}
				<div class="rv-right-body">{@render commentsPanel()}</div>
			{/if}
		</aside>
	</div>
</div>

{#if clearing}
	<ClearReviewsModal
		{seenAt}
		finished={finishedNotes}
		total={totalNotes}
		onClose={() => (clearing = false)}
	/>
{/if}

{#if deciding}
	<ReviewDecideModal
		suggestions={pendingHere}
		beforeAccept={flushEditor}
		onAccepted={(ids, accepted) => editorRef?.applyAccepted(ids, accepted)}
		onClose={() => (deciding = false)}
	/>
{/if}

{#if manage && rowMenu}
	<StoryRowMenu
		menu={rowMenu}
		chapterCount={chapters.length}
		assistantEnabled={assistantSurfaces}
		{selectedSceneId}
		{mergeSelection}
		onClose={closeRowMenu}
		onRenameChapter={(id) => {
			renamingChapterId = id;
			rowMenu = null;
		}}
		onOpenReview={openReviewFor}
		onDuplicateScene={duplicateScene}
		onMergeSelected={mergeSelectedScenes}
	/>
{/if}

<style>
	/* One panel: the pane is just the panel, which carries its own title. */
	.rv-right-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	/* Lets the chat fill the space under the launcher button. */
	.rv-assistant-wrap {
		flex: 1;
		min-height: 0;
	}
	.rv-review-btn {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		justify-content: center;
		margin: 10px 10px 2px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		background: var(--bg-elevated);
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		cursor: pointer;
	}
	.rv-review-btn:hover {
		background: var(--accent-soft);
	}
</style>
