<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { withQuery } from '#lib/href';
	import { focusShownPane } from '#lib/pane-focus';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { afterNavigate, beforeNavigate, goto, refreshAll, snapshot } from '$app/navigation';
	import { refreshStoryLive } from './live';
	import { altLabel, modLabel } from '#lib/keys';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { focusMode } from '#lib/focus-mode.svelte';
	import { assistantIntent } from '#lib/assistant.svelte';
	import { openReviewModal } from '#lib/review-modal.svelte';
	import ReviewModal from '#lib/components/ReviewModal.svelte';
	import QuickNote from '#lib/components/QuickNote.svelte';
	import EntityBadge from '#lib/components/EntityBadge.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import StoryPreview from '#lib/components/StoryPreview.svelte';
	import { editorStyleVars } from '#lib/page-setup';
	import { nearViewport } from '#lib/near-viewport';
	import type { ViewItem } from '#lib/components/ViewMenu.svelte';
	import StoryOutline from '#lib/components/StoryOutline.svelte';
	import StoryRowMenu, {
		type RowMenuState,
		type RowMenuTarget
	} from '#lib/components/StoryRowMenu.svelte';
	import {
		duplicateScene as duplicateSceneAction,
		mergeScenes as mergeScenesAction,
		persistProposalState,
		splitScene as splitSceneAction
	} from '#lib/scene-actions';
	import EditorToolbar from '#lib/components/EditorToolbar.svelte';
	import EntityCard from '#lib/components/EntityCard.svelte';
	import type { EntityCardData } from '#lib/wire-types';
	import RevisionHistory from '#lib/components/RevisionHistory.svelte';
	import RevisionPreview from '#lib/components/RevisionPreview.svelte';
	import SceneEditor, { type SaveStatus } from '#lib/components/SceneEditor.svelte';
	import type { EditorView } from '@codemirror/view';
	import AssistantPanel from '#lib/components/AssistantPanel.svelte';
	import PanelStrip from '#lib/components/PanelStrip.svelte';
	import { activePanel, visiblePanels, type PanelId } from '#lib/panels';
	import SidebarSearch from '#lib/components/SidebarSearch.svelte';
	import AppBar from '#lib/components/AppBar.svelte';
	import { storyPath as storyCrumbs, LEFT_PANE_LABEL, RIGHT_PANE_LABEL } from '#lib/chrome';
	import type { PageData } from './$types';
	import ModeSwitcher from '#lib/components/ModeSwitcher.svelte';
	import { apiErrorMessage } from '#lib/format';
	import {
		toggleCommandMarkers as toggleCommandMarkersView,
		toggleNonPrintingMarks
	} from '#lib/editor-view';

	let { data }: { data: PageData } = $props();

	// The platform's modifier labels for shortcut hints; SSR says Ctrl/Alt.
	let mod = $state<'Cmd' | 'Ctrl'>('Ctrl');
	let alt = $state<'Option' | 'Alt'>('Alt');
	onMount(() => {
		mod = modLabel();
		alt = altLabel();
	});

	// The writing surface's typography as CSS variables: the font and line
	// spacing come from the writer's editor-appearance preferences; the default
	// alignment rides with page setup, since it travels into the export.
	const editorStyle = $derived(
		editorStyleVars({ ...data.preferences, textAlign: data.pageSetup.textAlign })
	);

	// The prose-view toggles (show non-printing marks, hide command markers)
	// are shared by every editor in the story and remembered per user. The
	// toolbar flips them; the change persists in the background so the next
	// visit opens the same way.
	// svelte-ignore state_referenced_locally
	let nonPrintingMarks = $state(data.preferences.nonPrintingMarks);
	// svelte-ignore state_referenced_locally
	let commandMarkers = $state(data.preferences.commandMarkers);
	function toggleNonPrinting() {
		nonPrintingMarks = toggleNonPrintingMarks(nonPrintingMarks);
	}
	function toggleCommandMarkers() {
		commandMarkers = toggleCommandMarkersView(commandMarkers);
	}

	// Where the writer was in the open scene, kept with the history entry:
	// the browser back button returns to the same scroll and caret instead
	// of the top of the scene.
	let sceneEditor = $state<SceneEditor>();

	// The editors that can hold unsaved words: the open scene's, or the
	// mounted ones in the whole-story view.
	const openEditors = () =>
		[sceneEditor, ...Object.values(docEditors)].filter((editor) => editor != null);

	// Lands every pending save; false when one failed and its words are still
	// only in the browser.
	async function flushEditors(): Promise<boolean> {
		const editors = openEditors();
		await Promise.all(editors.map((editor) => editor.flushSave()));
		// One more pass for an image upload that landed during the first (the
		// writer chose to leave while it was still on its way).
		const dirty = editors.filter((editor) => editor.isDirty());
		await Promise.all(dirty.map((editor) => editor.flushSave()));
		return !editors.some((editor) => editor.isDirty());
	}

	// Set while the page saves and then replaces the open scene (a scene
	// switch, split or merge). The editors stay on screen but take no typing:
	// words typed then would land after the save and vanish with the remount.
	// A count, not a flag: overlapping actions (a second merge clicked while
	// the first is still running) must not unpause each other early.
	let pauseDepth = $state(0);
	const typingPaused = $derived(pauseDepth > 0);
	async function pauseTypingWhile<T>(work: () => Promise<T>): Promise<T> {
		pauseDepth++;
		try {
			return await work();
		} finally {
			pauseDepth--;
			// A place clicked while a split, merge or duplicate ran: go there now.
			// By URL even for Back or Forward, since the action may have added a
			// history entry that would throw a replayed step off. Other goto
			// options (replaceState, noScroll) are not visible to the guard.
			const queued = queuedNavigation;
			if (pauseDepth === 0 && queued && !destroyed) {
				queuedNavigation = null;
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- a URL the writer already chose
				void goto(queued.url, { refreshAll: queued.refresh });
			}
		}
	}

	const LEAVE_UNSAVED =
		'The latest changes to this scene could not be saved. Leave anyway and lose them? Cancel to stay on the scene.';
	const uploading = () => openEditors().some((editor) => editor.isUploading());
	const LEAVE_UPLOADING =
		'An image is still uploading into this scene and may not be added if you leave now. Leave anyway? Cancel to stay until it is in.';
	const WAIT_UPLOADING = 'An image is still uploading into this scene. Try again once it is in.';
	const BUSY = 'Another change to the scenes is still running. Try again when it is done.';
	const SAVE_FAILED =
		'The scene could not be saved, so nothing was changed. If the scene says it was changed in another window, choose Load newer version or Keep mine first. Otherwise, try again in a moment.';

	// A quick scene round-trip (A to B and back) faster than the debounced
	// save lands would let the reload of A return stale prose, which the
	// remounted editor then owns. Flush pending saves before any client
	// navigation. If one fails, the writer chooses: stay with the words on
	// screen, or leave without them. A full unload is left to SceneEditor's
	// own pagehide flush.
	// refresh: a goto or form may have asked for fresh data, so the replay does.
	type Target = { url: URL; delta: number | undefined; refresh: boolean };
	let ownNavigation: string | null = null;
	// Resolves the wait for a replayed Back or Forward to start.
	let replayStarted: (() => void) | null = null;
	// The latest place clicked while the guard lands a save, or while a
	// split, merge or duplicate runs.
	let heldNavigation: Target | null = null;
	let queuedNavigation: Target | null = null;
	const REPLAY_WAIT_MS = 1000;

	// A navigation the page makes itself after its saves have landed; the
	// guard lets it through. Returns whether it arrived: another navigation
	// can cut it short.
	async function ownGoto(to: ResolvedPathname | URL, opts?: Parameters<typeof goto>[1]) {
		const href = new URL(to, page.url.href).href;
		ownNavigation = href;
		try {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved by the caller
			await goto(to, opts);
		} finally {
			if (ownNavigation === href) ownNavigation = null;
		}
		return page.url.href === href;
	}
	// Opens a scene after a split, merge or duplicate changed the stored text,
	// remounting every editor on the new text. If a Back or Forward cut the
	// move short, this page's data is reloaded instead, so no editor keeps
	// text the action replaced; the queued move runs once the pause ends.
	async function openChangedScene(sceneId: string) {
		if (!(await ownGoto(withQuery(storyPath, { scene: sceneId }), { refreshAll: true })))
			await refreshAll();
		editorNonce++;
	}
	let destroyed = false;
	onDestroy(() => (destroyed = true));
	beforeNavigate((nav) => {
		if (nav.willUnload || !nav.to) return;
		// The navigation this guard re-issues once the saves have landed.
		if (nav.to.url.href === ownNavigation) {
			ownNavigation = null;
			replayStarted?.();
			return;
		}
		// Same-document hash jumps (story-view scene anchors) reload nothing.
		if (
			nav.from &&
			nav.to.url.pathname === nav.from.url.pathname &&
			nav.to.url.search === nav.from.url.search
		)
			return;
		const target: Target = {
			url: nav.to.url,
			delta: nav.type === 'popstate' ? nav.delta : undefined,
			refresh: nav.type !== 'link'
		};
		// A save is already being landed for an earlier navigation: go to the
		// latest place clicked once it lands.
		if (heldNavigation) {
			nav.cancel();
			heldNavigation = target;
			return;
		}
		// A split, merge or duplicate is running: go once it is done.
		if (typingPaused) {
			nav.cancel();
			queuedNavigation = target;
			return;
		}
		if (!openEditors().some((editor) => editor.isDirty()) && !uploading()) return;
		nav.cancel();
		if (uploading() && !confirm(LEAVE_UPLOADING)) return;
		heldNavigation = target;
		void pauseTypingWhile(async () => {
			const saved = await flushEditors();
			const { url, delta, refresh } = heldNavigation ?? target;
			heldNavigation = null;
			if (destroyed) return;
			if (!saved && !confirm(LEAVE_UNSAVED)) return;
			// Back and Forward move through history rather than adding to it.
			// Stay paused until the move starts; if it never does (the entry
			// is gone), stop waiting and drop the exemption.
			if (delta) {
				ownNavigation = url.href;
				await new Promise<void>((resolve) => {
					replayStarted = resolve;
					history.go(delta);
					setTimeout(resolve, REPLAY_WAIT_MS);
				});
				replayStarted = null;
				ownNavigation = null;
			} else await ownGoto(url, { refreshAll: refresh });
		});
	});

	type ScenePosition = { sceneId: string; anchor: number; scroll: number };
	snapshot<ScenePosition | null>({
		id: 'scene-position',
		capture: () => {
			const position = sceneEditor?.getViewPosition();
			if (!position || !data.selectedScene) return null;
			return { sceneId: data.selectedScene.id, ...position };
		},
		restore: (value) => {
			if (value && value.sceneId === data.selectedScene?.id) {
				sceneEditor?.restoreViewPosition(value);
			}
		}
	});

	// Picking which entity a shared name means: store the pin, then let the
	// data refresh re-render the underlines (the editor reconfigures its
	// mentions when the pins change).
	async function pinMention(name: string, target: { type: string; id: string }) {
		const response = await fetch(`/api/stories/${data.story.id}/mention-pins`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name, targetType: target.type, targetId: target.id })
		});
		if (response.ok) await refreshAll();
	}

	const mentionOptions = $derived({
		storyMembers: data.storyMemberIds,
		pins: data.mentionPins,
		onPin: pinMention,
		entityHref: (entity: { id: string }) =>
			`/universes/${data.universe.slug}/plan?entity=${entity.id}`,
		onOpenCard: (entityId: string) => openCard(entityId)
	});

	// The read-only entity card that takes over the right column. The stack
	// holds the ids visited so Back walks them; an empty stack shows the tabs.
	let inspectStack = $state<string[]>([]);
	let inspectCard = $state<EntityCardData | null>(null);

	async function loadCard(entityId: string) {
		inspectCard = null;
		const response = await fetch(`/api/entities/${entityId}/card`);
		if (!response.ok) {
			closeInspect();
			return;
		}
		inspectCard = (await response.json()) as EntityCardData;
	}

	// On a narrow window one pane shows at a time (the .pane-tabs bar).
	// Opening a scene shows the writing; opening a card shows the side panel.
	type PaneTab = 'nav' | 'read' | 'notes';
	const PANE_TABS: { id: PaneTab; label: string }[] = [
		{ id: 'nav', label: 'Scenes' },
		{ id: 'read', label: 'Writing' },
		{ id: 'notes', label: 'Side panel' }
	];
	let paneTab = $state<PaneTab>('read');
	const paneEls: Partial<Record<PaneTab, HTMLElement>> = {};
	let paneTabsEl = $state<HTMLElement>();
	// Switches pane without the tab bar.
	async function showPane(tab: PaneTab) {
		if (paneTab === tab) return;
		paneTab = tab;
		await tick();
		focusShownPane(paneTabsEl, paneEls[tab]);
	}
	// Set while an Assistant proposal card changes scene, so the chat stays open.
	let keepPaneOnNavigate = false;
	afterNavigate(({ from, to, type }) => {
		if (keepPaneOnNavigate) return;
		// A followed link (even to the scene already open) or a different scene,
		// view or anchor; not a data refresh of this one.
		if (type === 'link' || from?.url.search !== to?.url.search || from?.url.hash !== to?.url.hash)
			void showPane('read');
	});
	async function openSceneKeepingPane(sceneId: string) {
		keepPaneOnNavigate = true;
		try {
			await openChangedScene(sceneId);
		} finally {
			keepPaneOnNavigate = false;
		}
	}

	function openCard(entityId: string) {
		void showPane('notes');
		inspectStack = [...inspectStack, entityId];
		void loadCard(entityId);
	}

	// Back walks the stack; from the first card it returns to the tabs.
	function backCard() {
		if (inspectStack.length <= 1) {
			closeInspect();
			return;
		}
		inspectStack = inspectStack.slice(0, -1);
		void loadCard(inspectStack[inspectStack.length - 1]);
	}

	function closeInspect() {
		inspectStack = [];
		inspectCard = null;
	}

	// The card is tied to the scene context it was opened from; leave it
	// behind when the open scene changes.
	$effect(() => {
		void selectedSceneId;
		closeInspect();
	});

	// The editor's create-from-selection menu; the refreshed page data
	// reconfigures the underlines, so the new name lights up in place.
	async function createEntity(
		type: 'character' | 'place' | 'lore_entry',
		name: string,
		categoryId?: string
	): Promise<string | null> {
		const response = await fetch(`/api/stories/${data.story.id}/entities`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ type, name, ...(categoryId ? { categoryId } : {}) })
		});
		if (!response.ok) {
			return await apiErrorMessage(response, 'Could not create it.');
		}
		await refreshAll();
		return null;
	}

	// Focus mode hides the chrome around the prose; Esc leaves it, and so
	// does leaving the page. Shared state, so the palette can toggle it.
	$effect(() => () => {
		focusMode.on = false;
	});

	let saveStatus = $state<SaveStatus>('idle');
	const selectedSceneId = $derived(data.selectedScene?.id);
	// While another scene, view or page is loading, the open scene stays on
	// screen but takes no typing: words typed there would be saved to it and
	// then vanish as the next one replaces it (#772).
	const leavingScene = $derived.by(() => {
		if (typingPaused) return true;
		const to = navigating.to?.url;
		if (!to) return false;
		if (to.pathname !== page.url.pathname) return true;
		if (to.search === page.url.search) return false;
		const changes = (key: string) => to.searchParams.get(key) !== page.url.searchParams.get(key);
		return (
			to.searchParams.get('scene') !== (data.selectedScene?.id ?? null) ||
			changes('view') ||
			changes('revision')
		);
	});
	$effect(() => {
		void selectedSceneId;
		saveStatus = 'idle';
	});

	// A palette jump to a text match carries the searched text; the editor
	// selects the first occurrence so the eye lands on it.
	const findText = $derived(page.url.searchParams.get('find'));

	// An appears-in jump carries the mention's character offset instead.
	const findAt = $derived.by(() => {
		const raw = page.url.searchParams.get('at');
		if (raw === null) return null;
		const at = Number.parseInt(raw, 10);
		return Number.isInteger(at) && at >= 0 ? at : null;
	});

	// The mention index rebuilds in the background after a save, so the
	// Reference tab can trail the text by a couple of seconds. While the
	// open scene's index watermark is behind its last edit (the worker's
	// own staleness test), keep refreshing until it catches up - bounded,
	// so a stopped worker does not leave the page polling forever.
	const MENTION_POLL_MS = 2000;
	const MENTION_POLL_LIMIT = 10;
	let mentionPolls = 0;
	$effect(() => {
		const scene = data.selectedScene;
		if (!scene) return;
		const stale = !scene.mentionsIndexedAt || scene.mentionsIndexedAt < scene.updatedAt;
		if (!stale || mentionPolls >= MENTION_POLL_LIMIT) return;
		const timer = setTimeout(() => {
			mentionPolls += 1;
			void refreshStoryLive();
		}, MENTION_POLL_MS);
		return () => clearTimeout(timer);
	});

	// Scenes picked for merging via the row menu; the merge joins them in
	// story order regardless of the picking order.
	let mergeSelection = new SvelteSet<string>();
	// Bumped when a merge rewrites a scene's text, so the open editors remount
	// on the merged text instead of saving over it.
	let editorNonce = $state(0);

	// Each of these acts once at a time: a second split or merge sent while
	// the first runs would act on text the first is about to change.
	async function mergeSelectedScenes() {
		rowMenu = null;
		if (typingPaused) return;
		if (uploading()) return alert(WAIT_UPLOADING);
		await pauseTypingWhile(async () => {
			// The merge reads the stored text, so pending saves land first.
			if (!(await flushEditors())) return alert(SAVE_FAILED);
			const result = await mergeScenesAction(data.story.id, [...mergeSelection]);
			if (!result.ok) return alert(result.message);
			mergeSelection.clear();
			await openChangedScene(result.targetSceneId);
		});
	}

	// Copies a scene in full directly after itself; useful for keeping a
	// scene as a reusable template.
	async function duplicateScene(sceneId: string) {
		rowMenu = null;
		if (typingPaused) return;
		if (uploading()) return alert(WAIT_UPLOADING);
		await pauseTypingWhile(async () => {
			// The copy is made from the stored text, so pending saves land first.
			if (!(await flushEditors())) return alert(SAVE_FAILED);
			const result = await duplicateSceneAction(data.story.id, sceneId);
			if (!result.ok) return alert(result.message);
			await openChangedScene(result.newSceneId);
		});
	}

	// Opens the review modal for a scene or chapter from the sidebar row menu;
	// the modal drives the run and reports progress in the activity center.
	function openReviewFor(request: { sceneId?: string; chapterId?: string }) {
		// Back on the row first, so closing the modal returns focus there.
		closeRowMenu(true);
		openReviewModal({
			level: request.sceneId ? 'scene' : 'chapter',
			sceneId: request.sceneId,
			chapterId: request.chapterId
		});
	}

	// Splits the open scene at the cursor, like a page break: the rest of
	// the text moves to a new untitled scene directly after this one.
	async function splitCurrentScene() {
		if (!sceneEditor || !data.selectedScene || typingPaused) return;
		if (uploading()) return alert(WAIT_UPLOADING);
		const sceneId = data.selectedScene.id;
		const cursor = sceneEditor.cursorOffset();
		if (!cursor || cursor.offset <= 0 || cursor.offset >= cursor.length) {
			alert('Put the cursor where the scene should break, inside the text.');
			return;
		}
		await pauseTypingWhile(async () => {
			// The offset must point into the stored text, so the pending autosave
			// lands first.
			if (!(await flushEditors())) return alert(SAVE_FAILED);
			const result = await splitSceneAction(sceneId, { offset: cursor.offset });
			if (!result.ok) return alert(result.message);
			await openChangedScene(result.newSceneId);
		});
	}

	// Records a proposal card's outcome on its stored chat turn, so the card
	// stays decided (or reopens after a revert) across reloads. Best effort:
	// the split or merge itself already landed.
	// Confirms a split the Assistant proposed in chat. The exact passage is
	// re-located server-side against the stored text, so the open editor's
	// pending save lands first; on success the new scene opens. The passage
	// may have moved into another scene (an earlier confirmed proposal), so
	// the response names the scene that was actually cut.
	async function confirmAssistantSplit(proposal: {
		sceneId: string;
		before: string;
	}): Promise<{ error: string } | { splitSceneId: string; newSceneId: string }> {
		if (typingPaused) return { error: BUSY };
		if (uploading()) return { error: WAIT_UPLOADING };
		return pauseTypingWhile(async () => {
			if (!(await flushEditors())) return { error: SAVE_FAILED };
			const result = await splitSceneAction(proposal.sceneId, { before: proposal.before });
			if (!result.ok) return { error: result.message };
			const { newSceneId, splitSceneId } = result;
			persistProposalState(data.story.id, proposal, { splitSceneId, newSceneId });
			await openSceneKeepingPane(newSceneId);
			return { splitSceneId, newSceneId };
		});
	}

	// Reverts a confirmed split from its proposal card: the two halves merge
	// back into one scene and the card reopens.
	async function revertAssistantSplit(proposal: {
		sceneId: string;
		before: string;
		confirmed: { splitSceneId: string; newSceneId: string };
	}): Promise<string | null> {
		if (typingPaused) return BUSY;
		if (uploading()) return WAIT_UPLOADING;
		return pauseTypingWhile(async () => {
			if (!(await flushEditors())) return SAVE_FAILED;
			const result = await mergeScenesAction(data.story.id, [
				proposal.confirmed.splitSceneId,
				proposal.confirmed.newSceneId
			]);
			if (!result.ok) return result.message;
			persistProposalState(data.story.id, proposal, null);
			await openSceneKeepingPane(result.targetSceneId);
			return null;
		});
	}

	// "Suggest where to split": a canned chat turn naming the scene, so the
	// Assistant reads it and stages a split proposal to confirm.
	function suggestSplit(sceneId: string) {
		rowMenu = null;
		const scene = data.scenes.find((s) => s.id === sceneId);
		const label = scene?.title ? `the scene "${scene.title}"` : 'this scene';
		assistantIntent.pending = {
			kind: 'send',
			text: `Suggest a natural place to split ${label} (scene id: ${sceneId}) in two. Read the scene first, then propose the split for me to confirm, quoting the exact words the new scene should open with.`
		};
	}

	// Which chapter shows its inline rename field; bound into the outline,
	// set from the row menu.
	let renamingChapterId = $state<string | null>(null);

	// Right-click menu for sidebar rows: chapter tools or the scene delete.
	// Same pattern as the editor's selection menu.
	let rowMenu = $state<RowMenuState | null>(null);
	let rowMenuTrigger: HTMLElement | null = null;

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

	const viewStory = $derived(data.view === 'story');
	const viewPreview = $derived(data.view === 'preview');
	// Both the continuous editor and the preview span the whole story; the top
	// bar treats them as one "whole story" state that toggles back to a scene.
	const inWholeStory = $derived(viewStory || viewPreview);
	const storyPath = $derived(resolve('/stories/[id]', { id: data.story.slug }));
	const notesPath = $derived(resolve('/stories/[id]/notes', { id: data.story.slug }));

	// Entering the story view carries the open scene along; leaving it returns
	// there.
	const toggleHref = $derived(
		inWholeStory
			? data.returnSceneId
				? withQuery(storyPath, { scene: data.returnSceneId })
				: storyPath
			: data.selectedScene
				? withQuery(storyPath, { view: 'story', scene: data.selectedScene.id })
				: withQuery(storyPath, { view: 'story' })
	);

	// The scene to return to is carried between the editor and preview so
	// leaving either lands on the scene that was open.
	const previewHref = $derived(
		withQuery(storyPath, { view: 'preview', scene: data.returnSceneId })
	);
	const editStoryHref = $derived(
		withQuery(storyPath, { view: 'story', scene: data.returnSceneId })
	);

	// The default scene-editor URL, the Edit target from the scene toolbar.
	const sceneEditHref = $derived(
		data.returnSceneId ? withQuery(storyPath, { scene: data.returnSceneId }) : storyPath
	);
	// The View dropdown shared by every toolbar: Edit, Preview, Focus, Print.
	// The Edit and Preview targets differ by scope (whole story vs the open
	// scene), so they are passed in.
	function viewItems(editTarget: ResolvedPathname, previewTarget: ResolvedPathname): ViewItem[] {
		return [
			{ id: 'edit', label: 'Edit', icon: 'pencil', href: editTarget, current: !viewPreview },
			{ id: 'preview', label: 'Preview', icon: 'book', href: previewTarget, current: viewPreview },
			{ id: 'focus', label: 'Focus', icon: 'expand', onSelect: () => (focusMode.on = true) },
			{
				id: 'print',
				label: 'Print',
				icon: 'print',
				href: resolve('/stories/[id]/print', { id: data.story.slug })
			}
		];
	}

	// The continuous view's one formatting bar acts on whichever stitched
	// editor last held the caret; default to the first so the bar is live
	// before the writer clicks in.
	let activeDocId = $state<string | null>(null);
	const toolbarView = () => docEditors[activeDocId ?? docOrder[0]]?.getView();

	// The right pane's panels. Reference is about the prose in view, so it is
	// always here; History needs one open scene; Notes is about the whole
	// story, and is the way into the Notes page now that the mode strip does
	// not carry one; the Assistant needs the account to have it configured
	// and switched on.
	const panels = $derived(
		visiblePanels({
			reference: true,
			assistant: data.assistant.tabEnabled,
			history: Boolean(data.selectedScene),
			notes: data.storyNotes.length
		})
	);
	let chosenPanel = $state<PanelId | null>('reference');
	const rightTab = $derived(activePanel(panels, chosenPanel));

	// An Assistant intent (from a menu here or the command palette) opens the
	// panel; the panel consumes the intent itself once it renders.
	$effect(() => {
		if (assistantIntent.pending && data.assistant.tabEnabled) {
			chosenPanel = 'assistant';
			untrack(() => showPane('notes'));
		}
	});

	// "Ask the Assistant about this" on an editor selection: the passage goes
	// into the chat composer as a reference and the writer asks their question.
	function askAssistant(sceneId: string, text: string) {
		assistantIntent.pending = { kind: 'reference', sceneId, text };
	}

	// Grounded starter prompts for an empty Assistant conversation, drawn from
	// the story's known characters so they name real entities; generic fallbacks
	// when the cast is empty.
	const assistantSuggestions = $derived.by(() => {
		const characters = data.mentionEntities
			.filter((entity) => entity.type === 'character')
			.map((entity) => entity.name);
		const title = data.story.title || 'this story';
		const prompts: string[] = [];
		if (characters[0]) prompts.push(`What's at stake for ${characters[0]} in ${title}?`);
		prompts.push('Suggest a complication for this scene.');
		if (characters[1]) prompts.push(`Is ${characters[1]}'s arc consistent so far?`);
		else prompts.push('Catch me up on the story so far.');
		return prompts;
	});
	// The scene's cast, grouped by entity type in this order.
	const IN_SCENE_GROUPS = [
		{ kind: 'character', label: 'Characters' },
		{ kind: 'place', label: 'Places' },
		{ kind: 'lore', label: 'Lore' }
	] as const;
	const sceneHref = $derived(
		data.selectedScene ? withQuery(storyPath, { scene: data.selectedScene.id }) : storyPath
	);

	// The sidebar filter: a matching chapter keeps all its scenes, otherwise
	// only matching scenes show, and a chapter with nothing left hides.
	// While filtering, chapters stay open and dragging is off.
	let sidebarQuery = $state('');
	const sceneQuery = $derived(sidebarQuery.trim().toLowerCase());

	function docScenes(chapterId: string | null) {
		return (data.storyDoc ?? []).filter((scene) => scene.chapterId === chapterId);
	}

	// The continuous view stitches one editor per scene; vertical arrows at
	// an editor's edge move the caret into the neighbouring scene.
	const docOrder = $derived([
		...data.chapters.flatMap((chapter) => docScenes(chapter.id).map((scene) => scene.id)),
		...docScenes(null).map((scene) => scene.id)
	]);
	let docEditors: Record<
		string,
		| {
				focusEdge: (edge: 'start' | 'end') => void;
				getView: () => EditorView | undefined;
				flushSave: () => Promise<void>;
				isDirty: () => boolean;
				isUploading: () => boolean;
		  }
		| undefined
	> = $state({});

	// A scene's editor mounts as the scene nears the visible part of the
	// document, so a long story does not open every editor at once; until
	// then the scene shows its text as plain lines. A mounted editor stays
	// until the writer leaves the view or opens another story, so coming back
	// starts lazy again instead of mounting everything seen last time.
	let docScroll = $state<HTMLElement>();
	const mountedDocScenes = new SvelteSet<string>();
	// svelte-ignore state_referenced_locally
	let mountedFor = `${data.story.id}:${data.view}`;
	$effect.pre(() => {
		const key = `${data.story.id}:${data.view}`;
		if (key === mountedFor) return;
		mountedFor = key;
		untrack(() => mountedDocScenes.clear());
	});

	async function mountDocScene(sceneId: string) {
		if (mountedDocScenes.has(sceneId)) return;
		mountedDocScenes.add(sceneId);
		await tick();
	}

	// A click or tab onto a scene that has not mounted yet (after a fast
	// scrollbar drag, say) mounts it and puts the caret where the click was.
	async function enterDocScene(sceneId: string, at?: { x: number; y: number }) {
		await mountDocScene(sceneId);
		const view = docEditors[sceneId]?.getView();
		if (!view) return;
		const pos = at ? view.posAtCoords(at) : null;
		view.focus();
		if (pos !== null) view.dispatch({ selection: { anchor: pos } });
	}

	async function focusNeighbor(sceneId: string, direction: 'up' | 'down') {
		const index = docOrder.indexOf(sceneId);
		const target = docOrder[index + (direction === 'down' ? 1 : -1)];
		if (!target) return;
		await mountDocScene(target);
		docEditors[target]?.focusEdge(direction === 'down' ? 'start' : 'end');
	}
</script>

<svelte:window
	onkeydown={(e) => {
		// Open menus consume Escape in the dismiss action before this fires.
		if (e.key === 'Escape') focusMode.on = false;
	}}
/>

<svelte:head>
	<title>{data.story.title} - Codex</title>
</svelte:head>

<div class="app" class:focus-mode={focusMode.on}>
	<AppBar
		crumbs={storyCrumbs(
			data.universe,
			{ ...data.story, reading: data.reading },
			{
				storyAt: 'story'
			}
		)}
		{saveStatus}
		helpTopic="editor"
		helpLabel="the editor"
	/>
	<nav class="seg full pane-tabs" aria-label="Story panes" bind:this={paneTabsEl}>
		{#each PANE_TABS as tab (tab.id)}
			<button
				class="seg-btn"
				class:active={paneTab === tab.id}
				type="button"
				aria-pressed={paneTab === tab.id}
				onclick={() => (paneTab = tab.id)}
			>
				{tab.label}
			</button>
		{/each}
	</nav>
	<div class="body" data-mtab={paneTab}>
		<aside class="pane left" aria-label={LEFT_PANE_LABEL} tabindex="-1" bind:this={paneEls.nav}>
			<div class="left-head">
				<ModeSwitcher
					active="write"
					hrefs={{
						plan: resolve('/stories/[id]/plan', { id: data.story.slug }),
						review: resolve('/stories/[id]/review', { id: data.story.slug })
					}}
				/>
				<SidebarSearch bind:query={sidebarQuery} placeholder="Filter chapters and scenes..." />
			</div>
			<div class="left-scroll">
				<StoryOutline
					story={{ id: data.story.id, title: data.story.title }}
					universeName={data.universe.name}
					storySiblings={data.storySiblings}
					chapters={data.chapters}
					scenes={data.scenes}
					trashedScenes={data.trashedScenes}
					selectedSceneId={selectedSceneId ?? null}
					{viewStory}
					{storyPath}
					query={sceneQuery}
					{mergeSelection}
					bind:renamingChapterId
					onOpenRowMenu={openRowMenu}
				/>
			</div>
		</aside>
		<main id="main" class="pane center" tabindex="-1" bind:this={paneEls.read}>
			{#if !inWholeStory}<h1 class="visually-hidden">{data.story.title} - Write</h1>{/if}
			{#if viewStory}
				{#snippet docScene(scene: NonNullable<typeof data.storyDoc>[number])}
					<article class="doc-scene" id="scene-{scene.id}">
						{#if data.preferences.continuousSceneMarks === 'shown'}
							<a
								class="doc-scene-mark"
								href={withQuery(storyPath, { scene: scene.id })}
								title="Edit this scene alone"
							>
								{scene.title ?? 'Untitled scene'}
							</a>
						{/if}
						{#if mountedDocScenes.has(scene.id)}
							<SceneEditor
								bind:this={docEditors[scene.id]}
								leaving={leavingScene}
								compact
								{editorStyle}
								sceneId={scene.id}
								storyId={data.story.id}
								title={scene.title}
								body={scene.bodyMd}
								entities={data.mentionEntities}
								{mentionOptions}
								assistantContinuation={data.assistant.surfacesEnabled}
								autocompleteMode={data.preferences.entityAutocomplete}
								editingMode={data.preferences.editingMode}
								spellCheck={data.preferences.spellCheck}
								writingLanguage={data.preferences.writingLanguage}
								{nonPrintingMarks}
								{commandMarkers}
								imageUniverseId={data.universe.id}
								markers={data.storyDocMarkers[scene.id] ?? []}
								loreCategories={data.loreCategories}
								onCreateEntity={createEntity}
								onAskAssistant={data.assistant.surfacesEnabled
									? (text) => askAssistant(scene.id, text)
									: undefined}
								onCrossBoundary={(direction) => focusNeighbor(scene.id, direction)}
								onFocus={() => (activeDocId = scene.id)}
								onStatus={(status) => {
									saveStatus = status;
									if (status === 'saved') void refreshStoryLive();
								}}
							/>
						{:else}
							<div
								class="editor compact"
								style={editorStyle}
								role="textbox"
								aria-label={scene.title ?? 'Untitled scene'}
								aria-multiline="true"
								tabindex="0"
								onpointerdown={(event) => {
									event.preventDefault();
									void enterDocScene(scene.id, { x: event.clientX, y: event.clientY });
								}}
								onfocus={() => void enterDocScene(scene.id)}
								{@attach docScroll && nearViewport(docScroll, () => mountedDocScenes.add(scene.id))}
							>
								<div class="editor-cm"><div class="prose-static">{scene.bodyMd}</div></div>
							</div>
						{/if}
					</article>
				{/snippet}
				<div class="md-editor">
					<EditorToolbar
						view={toolbarView}
						viewMenu={viewItems(editStoryHref, previewHref)}
						storyView={{ active: inWholeStory, toggleHref }}
						nonPrintingActive={nonPrintingMarks === 'shown'}
						onToggleNonPrinting={toggleNonPrinting}
						commandMarkersActive={commandMarkers === 'shown'}
						onToggleCommandMarkers={toggleCommandMarkers}
					/>
					<div class="editor-scroll" bind:this={docScroll}>
						<div class="editor story-doc">
							<h1 class="doc-title">{data.story.title}</h1>
							{#if (data.storyDoc ?? []).length === 0}
								<div class="empty-state">
									<p class="empty-state-text">
										Nothing written yet. Switch back to the editor to add scenes.
									</p>
								</div>
							{/if}
							{#each data.chapters as chapter, index (chapter.id)}
								{@const docList = docScenes(chapter.id)}
								{#if docList.length > 0}
									<section class="doc-chapter" id="chapter-{chapter.id}">
										<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
										{#each docList as scene (`${scene.id}:${editorNonce}`)}
											{@render docScene(scene)}
										{/each}
									</section>
								{/if}
							{/each}
							{#if docScenes(null).length > 0}
								<section class="doc-chapter">
									<h2>Unfiled scenes</h2>
									{#each docScenes(null) as scene (`${scene.id}:${editorNonce}`)}
										{@render docScene(scene)}
									{/each}
								</section>
							{/if}
						</div>
					</div>
				</div>
			{:else if viewPreview}
				<StoryPreview
					storyTitle={data.story.title}
					chapters={data.chapters}
					storyDoc={data.storyDoc ?? []}
					pageSetup={data.pageSetup}
					{editStoryHref}
					{toggleHref}
				/>
			{:else if data.selectedScene && data.revisionPreview}
				<div class="editor">
					<RevisionPreview
						revision={data.revisionPreview}
						currentBody={data.selectedScene.bodyMd}
						entityType="scene"
						entityId={data.selectedScene.id}
						exitHref={sceneHref}
					/>
				</div>
			{:else if data.selectedScene}
				{#key `${data.selectedScene.id}:${editorNonce}`}
					<SceneEditor
						bind:this={sceneEditor}
						leaving={leavingScene}
						{editorStyle}
						onSplitScene={splitCurrentScene}
						storyView={{ active: inWholeStory, toggleHref }}
						viewMenu={viewItems(
							sceneEditHref,
							withQuery(storyPath, { view: 'preview', scene: data.selectedScene.id })
						)}
						{nonPrintingMarks}
						{commandMarkers}
						onToggleNonPrinting={toggleNonPrinting}
						onToggleCommandMarkers={toggleCommandMarkers}
						sceneId={data.selectedScene.id}
						storyId={data.story.id}
						assistantContinuation={data.assistant.surfacesEnabled}
						title={data.selectedScene.title}
						body={data.selectedScene.bodyMd}
						{findText}
						{findAt}
						entities={data.mentionEntities}
						{mentionOptions}
						autocompleteMode={data.preferences.entityAutocomplete}
						editingMode={data.preferences.editingMode}
						spellCheck={data.preferences.spellCheck}
						writingLanguage={data.preferences.writingLanguage}
						imageUniverseId={data.universe.id}
						markers={data.sceneMarkers}
						loreCategories={data.loreCategories}
						onCreateEntity={createEntity}
						onAskAssistant={data.assistant.surfacesEnabled
							? (text) => askAssistant(data.selectedScene!.id, text)
							: undefined}
						onStatus={(status) => {
							saveStatus = status;
							// Refresh the tree so the sidebar name and word count track edits.
							if (status === 'saved') {
								mentionPolls = 0;
								void refreshStoryLive();
							}
						}}
					/>
				{/key}
			{:else if data.scenes.length === 0}
				<div class="empty-state">
					<p class="empty-state-text">
						Create a chapter in the sidebar, then add a scene to it to start writing.
					</p>
				</div>
			{:else}
				<div class="empty-state">
					<p class="empty-state-text">Select a scene in the sidebar.</p>
				</div>
			{/if}
		</main>
		<aside class="pane right" aria-label={RIGHT_PANE_LABEL} tabindex="-1" bind:this={paneEls.notes}>
			{#if inspectStack.length > 0}
				{#if inspectCard}
					<EntityCard
						card={inspectCard}
						onBack={backCard}
						onOpen={openCard}
						planHref={withQuery(resolve('/stories/[id]/plan', { id: data.story.slug }), {
							entity: inspectCard.id
						})}
					/>
				{:else}
					<div class="empty-state tight"><p class="empty-state-text">Loading...</p></div>
				{/if}
			{:else}
				<PanelStrip
					{panels}
					active={rightTab ?? 'reference'}
					onSelect={(id) => (chosenPanel = id)}
					label="Panels about this scene"
				>
					{#snippet panel(id)}
						{#if id === 'assistant'}
							<AssistantPanel
								scope={{ storyId: data.story.id, storyTitle: data.story.title }}
								sceneId={data.selectedScene?.id ?? null}
								name={data.assistant.name}
								muted={data.assistant.muted}
								suggestions={assistantSuggestions}
								initialMessages={data.assistantChat}
								summarised={data.assistantChatSummarised}
								onConfirmSplit={confirmAssistantSplit}
								onRevertSplit={revertAssistantSplit}
								insertPaused={leavingScene}
								reviewHref={resolve('/stories/[id]/review', { id: data.story.slug })}
								onInsert={data.selectedScene && !inWholeStory && !data.revisionPreview
									? (text) => {
											void showPane('read');
											sceneEditor?.insertAtCursor(text);
										}
									: undefined}
								getSelection={data.selectedScene && !inWholeStory && !data.revisionPreview
									? () => sceneEditor?.getSelectionText() ?? null
									: undefined}
								onReplaceSelection={data.selectedScene && !inWholeStory && !data.revisionPreview
									? (text) => {
											void showPane('read');
											sceneEditor?.replaceSelection(text);
										}
									: undefined}
							/>
						{:else if id === 'history' && data.selectedScene}
							<RevisionHistory
								entityType="scene"
								entityId={data.selectedScene.id}
								revisions={data.sceneRevisions}
								previewId={data.revisionPreview?.id}
								previewHref={(revisionId) => withQuery(sceneHref, { revision: revisionId })}
							/>
						{:else if id === 'notes'}
							{@const onScene = new Set(data.sceneNotes.map((note) => note.id))}
							{@const otherNotes = data.storyNotes.filter((note) => !onScene.has(note.id))}
							<div class="right-scroll">
								{#if data.selectedScene && data.sceneNotes.length > 0}
									<div class="r-card">
										<h5>On this scene</h5>
										{#each data.sceneNotes as note (note.id)}
											<a class="r-line" href={withQuery(notesPath, { note: note.id })}>
												<span class="r-line-left">
													<span class="r-line-name">{note.title ?? 'Untitled note'}</span>
												</span>
											</a>
										{/each}
									</div>
								{/if}
								{#if otherNotes.length > 0}
									<div class="r-card">
										<h5>In this story</h5>
										{#each otherNotes as note (note.id)}
											<a class="r-line" href={withQuery(notesPath, { note: note.id })}>
												<span class="r-line-left">
													<span class="r-line-name">{note.title ?? 'Untitled note'}</span>
												</span>
											</a>
										{/each}
									</div>
								{:else if data.storyNotes.length === 0}
									<div class="empty-state tight">
										<p class="empty-state-text">No notes in this story yet.</p>
									</div>
								{/if}
								{#if data.selectedScene}
									<form method="POST" action="?/newSceneNote">
										<input type="hidden" name="sceneId" value={data.selectedScene.id} />
										<button class="btn btn-sm btn-secondary" type="submit">
											New note on this scene
										</button>
									</form>
								{:else}
									<form method="POST" action="{notesPath}?/createNote">
										<button class="btn btn-sm btn-secondary" type="submit">New note</button>
									</form>
								{/if}
								<a class="btn btn-sm btn-ghost" href={notesPath}>All notes</a>
							</div>
						{:else}
							<div class="right-scroll">
								{#if data.storyTodos.length > 0}
									<div class="r-card">
										<h5>To do</h5>
										{#each data.storyTodos as todo, ti (ti)}
											<div class="todo-row">
												{#if todo.markerId}
													<button
														class="todo-check"
														type="button"
														title="Mark done"
														aria-label="Mark done"
														onclick={async () => {
															await fetch(`/api/markers/${todo.markerId}`, {
																method: 'PUT',
																headers: { 'content-type': 'application/json' },
																body: JSON.stringify({ resolved: true })
															});
															await refreshAll();
														}}
													></button>
												{:else}
													<span class="todo-dot" title="A TODO: line; delete it when done"></span>
												{/if}
												<a class="todo-text" href={withQuery(storyPath, { scene: todo.sceneId })}>
													{todo.text}
													<span class="todo-scene">{todo.sceneTitle ?? 'Untitled scene'}</span>
												</a>
											</div>
										{/each}
										<div class="todo-hint">
											Write a line starting with TODO:, or select prose and press {mod}+{alt}+M.
										</div>
									</div>
								{/if}
								{#if data.selectedScene && data.inScene.length > 0}
									<div class="r-card">
										<h5>In this scene</h5>
										{#each IN_SCENE_GROUPS as group (group.kind)}
											{@const rows = data.inScene.filter((entity) => entity.kind === group.kind)}
											{#if rows.length > 0}
												<h6 class="r-sub">{group.label}</h6>
												{#each rows as entity (entity.id)}
													<button class="r-line" type="button" onclick={() => openCard(entity.id)}>
														<span class="r-line-left">
															<EntityBadge
																name={entity.name}
																badgeColor={entity.badgeColor}
																badgeAssetId={entity.badgeAssetId}
																categoryColor={entity.categoryColor}
															/>
															<span class="r-line-name">{entity.name}</span>
														</span>
														<span class="r-count">{entity.count}</span>
													</button>
												{/each}
											{/if}
										{/each}
									</div>
								{:else}
									<div class="empty-state tight">
										<p class="empty-state-text">
											{#if data.selectedScene}
												Mention a character, place, or lore entry from Plan in this scene and it
												shows up here after the scene saves.
											{:else}
												Open a scene to see the Plan entries it mentions.
											{/if}
										</p>
									</div>
								{/if}
							</div>
						{/if}
					{/snippet}
				</PanelStrip>
			{/if}
		</aside>
	</div>

	{#if focusMode.on}
		<div class="focus-controls">
			<button
				class="icon-btn"
				type="button"
				title="Exit focus (Esc)"
				aria-label="Exit focus (Esc)"
				onclick={() => (focusMode.on = false)}
			>
				<Icon name="compress" />
			</button>
		</div>
	{/if}
</div>

{#if rowMenu}
	<StoryRowMenu
		menu={rowMenu}
		chapterCount={data.chapters.length}
		assistantEnabled={data.assistant.surfacesEnabled}
		selectedSceneId={selectedSceneId ?? null}
		{mergeSelection}
		onClose={closeRowMenu}
		onRenameChapter={(id) => {
			renamingChapterId = id;
			rowMenu = null;
		}}
		onOpenReview={openReviewFor}
		onSuggestSplit={suggestSplit}
		onDuplicateScene={duplicateScene}
		onMergeSelected={mergeSelectedScenes}
	/>
{/if}

{#if data.assistant.surfacesEnabled}
	<ReviewModal
		storyId={data.story.id}
		storySlug={data.story.slug}
		chapters={data.chapters}
		scenes={data.scenes}
		defaultSceneId={selectedSceneId ?? null}
	/>
{/if}

<QuickNote storyId={data.story.id} sceneId={data.selectedScene?.id ?? null} />

<style>
	main.pane.center {
		scroll-behavior: smooth;
	}
	.doc-title {
		font-family: var(--font-content);
		font-size: 34px;
		font-weight: 600;
		letter-spacing: -0.015em;
		margin: 0 0 30px;
	}
	.doc-chapter {
		scroll-margin-top: 24px;
	}
	.doc-chapter h2 {
		font-family: var(--font-content);
		font-size: 23px;
		font-weight: 600;
		margin: 40px 0 16px;
	}
	.doc-scene {
		margin: 0 0 30px;
		scroll-margin-top: 24px;
	}
	.doc-scene-mark {
		display: block;
		color: var(--text-faint);
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		text-decoration: none;
		margin: 0 0 8px;
	}
	.doc-scene-mark:hover {
		color: var(--accent-ink);
	}
	/* Read-only preview: prose through the export renderer, styled to read
	   like the finished book. */
	.todo-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 5px 0;
		border-bottom: 1px dashed var(--border);
	}
	.todo-check {
		width: 14px;
		height: 14px;
		margin-top: 2px;
		flex: none;
		border: 1.5px solid var(--cat-amber);
		border-radius: 4px;
		background: none;
		cursor: pointer;
	}
	.todo-check:hover {
		background: color-mix(in oklab, var(--cat-amber) 30%, transparent);
	}
	.todo-dot {
		width: 14px;
		height: 14px;
		margin-top: 2px;
		flex: none;
		border-radius: 99px;
		background: color-mix(in oklab, var(--cat-amber) 35%, transparent);
	}
	.todo-text {
		flex: 1;
		min-width: 0;
		text-decoration: none;
		color: var(--text);
		font-size: 12.5px;
		line-height: 1.45;
	}
	.todo-scene {
		display: block;
		color: var(--text-faint);
		font-size: 11.5px;
	}
	.todo-hint {
		color: var(--text-faint);
		font-size: 11.5px;
		padding-top: 8px;
	}
</style>
