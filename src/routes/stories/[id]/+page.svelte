<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { focusMode } from '$lib/focus-mode.svelte';
	import { assistantIntent } from '$lib/assistant.svelte';
	import { reviewSceneWithAssistant } from '$lib/assistant-actions';
	import EntityBadge from '$lib/components/EntityBadge.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import EntityCard from '$lib/components/EntityCard.svelte';
	import type { EntityCardData } from '$lib/wire-types';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import SceneEditor, { type SaveStatus } from '$lib/components/SceneEditor.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { PAGE_FONTS, contentWidthCss, lineHeight } from '$lib/page-setup';
	import type { EditorView } from '@codemirror/view';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import SessionPanel from '$lib/components/SessionPanel.svelte';
	import AssistantPanel from '$lib/components/AssistantPanel.svelte';
	import SidebarSearch from '$lib/components/SidebarSearch.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { PageData, Snapshot } from './$types';
	import { dismiss } from '$lib/dismiss';
	import ModeSwitcher from '$lib/components/ModeSwitcher.svelte';
	import { apiErrorMessage } from '$lib/format';

	let { data }: { data: PageData } = $props();

	// The prose-view toggles (show non-printing marks, hide command markers)
	// are shared by every editor in the story and remembered per user. The
	// toolbar flips them; the change persists in the background so the next
	// visit opens the same way.
	// svelte-ignore state_referenced_locally
	let nonPrintingMarks = $state(data.preferences.nonPrintingMarks);
	// svelte-ignore state_referenced_locally
	let commandMarkers = $state(data.preferences.commandMarkers);
	function persistEditorView(patch: { nonPrintingMarks?: string; commandMarkers?: string }) {
		void fetch('/api/editor-view', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch)
		}).catch(() => {});
	}
	function toggleNonPrinting() {
		nonPrintingMarks = nonPrintingMarks === 'shown' ? 'hidden' : 'shown';
		persistEditorView({ nonPrintingMarks });
	}
	function toggleCommandMarkers() {
		commandMarkers = commandMarkers === 'shown' ? 'hidden' : 'shown';
		persistEditorView({ commandMarkers });
	}

	// Where the writer was in the open scene, kept with the history entry:
	// the browser back button returns to the same scroll and caret instead
	// of the top of the scene.
	let sceneEditor = $state<SceneEditor>();

	// A quick scene round-trip (A to B and back) faster than the debounced
	// save lands would let the reload of A return stale prose, which the
	// remounted editor then owns. Flush the open scene's pending save before
	// any client navigation, the way splitCurrentScene already does. A full
	// unload is left to SceneEditor's own pagehide flush.
	let flushingNav = false;
	beforeNavigate((nav) => {
		if (flushingNav || nav.willUnload || !nav.to) return;
		// Same-document hash jumps (story-view scene anchors) reload nothing.
		if (
			nav.from &&
			nav.to.url.pathname === nav.from.url.pathname &&
			nav.to.url.search === nav.from.url.search
		)
			return;
		if (!sceneEditor?.isDirty()) return;
		nav.cancel();
		flushingNav = true;
		const url = nav.to.url;
		void sceneEditor.flushSave().finally(() => {
			flushingNav = false;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- replaying the cancelled navigation's own resolved URL
			void goto(url);
		});
	});

	type ScenePosition = { sceneId: string; anchor: number; scroll: number };
	export const snapshot: Snapshot<ScenePosition | null> = {
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
	};

	// Picking which entity a shared name means: store the pin, then let the
	// data refresh re-render the underlines (the editor reconfigures its
	// mentions when the pins change).
	async function pinMention(name: string, target: { type: string; id: string }) {
		const response = await fetch(`/api/stories/${data.story.id}/mention-pins`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name, targetType: target.type, targetId: target.id })
		});
		if (response.ok) await invalidateAll();
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

	function openCard(entityId: string) {
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
		await invalidateAll();
		return null;
	}

	// Focus mode hides the chrome around the prose; Esc leaves it, and so
	// does leaving the page. Shared state, so the palette can toggle it.
	$effect(() => () => {
		focusMode.on = false;
	});

	let saveStatus = $state<SaveStatus>('idle');
	const selectedSceneId = $derived(data.selectedScene?.id);
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
			void invalidateAll();
		}, MENTION_POLL_MS);
		return () => clearTimeout(timer);
	});

	// Scenes picked for merging via the row menu; the merge joins them in
	// story order regardless of the picking order.
	let mergeSelection = new SvelteSet<string>();

	function toggleMergeSelection(sceneId: string) {
		if (mergeSelection.has(sceneId)) mergeSelection.delete(sceneId);
		else mergeSelection.add(sceneId);
		rowMenu = null;
	}

	async function mergeSelectedScenes() {
		rowMenu = null;
		const response = await fetch(`/api/stories/${data.story.id}/merge-scenes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sceneIds: [...mergeSelection] })
		});
		if (!response.ok) {
			alert(await apiErrorMessage(response, 'Could not merge the scenes.'));
			return;
		}
		const { targetSceneId } = (await response.json()) as { targetSceneId: string };
		mergeSelection.clear();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${targetSceneId}`, { invalidateAll: true });
	}

	// Copies a scene in full directly after itself; useful for keeping a
	// scene as a reusable template.
	async function duplicateScene(sceneId: string) {
		rowMenu = null;
		const response = await fetch(`/api/stories/${data.story.id}/duplicate-scene`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sceneId })
		});
		if (!response.ok) {
			alert(await apiErrorMessage(response, 'Could not duplicate the scene.'));
			return;
		}
		const { newSceneId } = (await response.json()) as { newSceneId: string };
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${newSceneId}`, { invalidateAll: true });
	}

	// Asks the Assistant to review one scene; it stages comments and suggested
	// edits the author then accepts or rejects on the review screen. Runs inline
	// (one scene is bounded), so a non-blocking banner covers the wait.
	let reviewingScene = $state(false);
	async function reviewScene(sceneId: string) {
		rowMenu = null;
		if (reviewingScene) return;
		reviewingScene = true;
		try {
			await reviewSceneWithAssistant(sceneId, `/stories/${data.story.slug}/review`);
		} finally {
			reviewingScene = false;
		}
	}

	// Reviews a whole chapter. Too long to run inline, so it queues a background
	// job and the owner is notified when it is ready.
	async function reviewChapter(chapterId: string) {
		rowMenu = null;
		const response = await fetch('/api/assistant/review-job', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ storyId: data.story.id, chapterId })
		});
		if (!response.ok) {
			alert(await apiErrorMessage(response, 'Could not start the chapter review.'));
			return;
		}
		alert(
			'The Assistant is reviewing this chapter in the background. You will be notified when its notes are ready on the review page.'
		);
	}

	// Splits the open scene at the cursor, like a page break: the rest of
	// the text moves to a new untitled scene directly after this one.
	async function splitCurrentScene() {
		if (!sceneEditor || !data.selectedScene) return;
		const cursor = sceneEditor.cursorOffset();
		if (!cursor || cursor.offset <= 0 || cursor.offset >= cursor.length) {
			alert('Put the cursor where the scene should break, inside the text.');
			return;
		}
		// The offset must point into the stored text, so the pending autosave
		// lands first.
		await sceneEditor.flushSave();
		const response = await fetch(`/api/scenes/${data.selectedScene.id}/split`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ offset: cursor.offset })
		});
		if (!response.ok) {
			alert(await apiErrorMessage(response, 'Could not split the scene.'));
			return;
		}
		const { newSceneId } = (await response.json()) as { newSceneId: string };
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${newSceneId}`, { invalidateAll: true });
	}

	// Records a proposal card's outcome on its stored chat turn, so the card
	// stays decided (or reopens after a revert) across reloads. Best effort:
	// the split or merge itself already landed.
	function persistProposalState(
		proposal: { sceneId: string; before: string },
		confirmed: { splitSceneId: string; newSceneId: string } | null
	) {
		void fetch(`/api/stories/${data.story.id}/assistant-proposal`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sceneId: proposal.sceneId, before: proposal.before, confirmed })
		}).catch(() => {});
	}

	// Confirms a split the Assistant proposed in chat. The exact passage is
	// re-located server-side against the stored text, so the open editor's
	// pending save lands first; on success the new scene opens. The passage
	// may have moved into another scene (an earlier confirmed proposal), so
	// the response names the scene that was actually cut.
	async function confirmAssistantSplit(proposal: {
		sceneId: string;
		before: string;
	}): Promise<{ error: string } | { splitSceneId: string; newSceneId: string }> {
		const editor =
			data.selectedScene?.id === proposal.sceneId ? sceneEditor : docEditors[proposal.sceneId];
		await editor?.flushSave();
		const response = await fetch(`/api/scenes/${proposal.sceneId}/split`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ before: proposal.before })
		});
		if (!response.ok) {
			return { error: await apiErrorMessage(response, 'Could not split the scene.') };
		}
		const { newSceneId, splitSceneId } = (await response.json()) as {
			newSceneId: string;
			splitSceneId: string;
		};
		persistProposalState(proposal, { splitSceneId, newSceneId });
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${newSceneId}`, { invalidateAll: true });
		return { splitSceneId, newSceneId };
	}

	// Reverts a confirmed split from its proposal card: the two halves merge
	// back into one scene and the card reopens.
	async function revertAssistantSplit(proposal: {
		sceneId: string;
		before: string;
		confirmed: { splitSceneId: string; newSceneId: string };
	}): Promise<string | null> {
		for (const id of [proposal.confirmed.splitSceneId, proposal.confirmed.newSceneId]) {
			const editor = data.selectedScene?.id === id ? sceneEditor : docEditors[id];
			await editor?.flushSave();
		}
		const response = await fetch(`/api/stories/${data.story.id}/merge-scenes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				sceneIds: [proposal.confirmed.splitSceneId, proposal.confirmed.newSceneId]
			})
		});
		if (!response.ok) {
			return await apiErrorMessage(response, 'Could not merge the scenes back.');
		}
		const { targetSceneId } = (await response.json()) as { targetSceneId: string };
		persistProposalState(proposal, null);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${targetSceneId}`, { invalidateAll: true });
		return null;
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

	// Chapters start expanded; collapsing is per-visit state.
	let collapsed = new SvelteSet<string>();

	// Which chapter shows its inline rename field, if any.
	let renamingChapterId = $state<string | null>(null);

	// The deleted-scenes list starts closed; its count shows in the header.
	let trashOpen = $state(false);

	// Right-click menu for sidebar rows: chapter tools or the scene delete.
	// Same pattern as the editor's selection menu.
	type RowMenuTarget =
		| { kind: 'chapter'; id: string; index: number }
		| { kind: 'scene'; id: string };
	let rowMenu = $state<{ x: number; y: number; target: RowMenuTarget } | null>(null);
	let rowMenuEl = $state<HTMLDivElement>();
	let rowMenuTrigger: HTMLElement | null = null;

	// The Assistant flyout inside the row menu; reset whenever the menu opens.
	let rowSubOpen = $state(false);

	function openRowMenu(event: MouseEvent, target: RowMenuTarget) {
		event.preventDefault();
		rowSubOpen = false;
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

	function onRowMenuKey(event: KeyboardEvent) {
		const items = rowMenuEl
			? [...rowMenuEl.querySelectorAll<HTMLButtonElement>('.row-menu-item')]
			: [];
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'Escape') {
			event.preventDefault();
			closeRowMenu(true);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			items[Math.min(current + 1, items.length - 1)]?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			items[Math.max(current - 1, 0)]?.focus();
		}
	}

	// Move focus into the menu when it opens, so keyboard users can act on it.
	$effect(() => {
		if (rowMenu && rowMenuEl) {
			rowMenuEl.querySelector<HTMLButtonElement>('.row-menu-item')?.focus();
		}
	});

	// The book switcher's menu, toggled from the sidebar header.
	let storyMenuOpen = $state(false);

	const orphanScenes = $derived(data.scenes.filter((scene) => scene.chapterId === null));

	const viewStory = $derived(data.view === 'story');
	const viewPreview = $derived(data.view === 'preview');
	// Both the continuous editor and the preview span the whole story; the top
	// bar treats them as one "whole story" state that toggles back to a scene.
	const inWholeStory = $derived(viewStory || viewPreview);
	const storyPath = $derived(resolve('/stories/[id]', { id: data.story.slug }));

	// Entering the story view carries the open scene along; leaving it returns
	// there.
	const toggleHref = $derived(
		inWholeStory
			? data.returnSceneId
				? `${storyPath}?scene=${data.returnSceneId}`
				: storyPath
			: data.selectedScene
				? `${storyPath}?view=story&scene=${data.selectedScene.id}`
				: `${storyPath}?view=story`
	);

	// The scene to return to is carried between the editor and preview so
	// leaving either lands on the scene that was open.
	const returnScenePart = $derived(data.returnSceneId ? `&scene=${data.returnSceneId}` : '');
	const previewHref = $derived(`${storyPath}?view=preview${returnScenePart}`);
	const editStoryHref = $derived(`${storyPath}?view=story${returnScenePart}`);

	// The continuous view's one formatting bar acts on whichever stitched
	// editor last held the caret; default to the first so the bar is live
	// before the writer clicks in.
	let activeDocId = $state<string | null>(null);
	const toolbarView = () => docEditors[activeDocId ?? docOrder[0]]?.getView();

	// Preview honours the story's paragraph style and scene-break text, like
	// the export. The break text is escaped for the CSS content property.
	const previewSpaced = $derived(data.pageSetup?.paragraphStyle === 'spaced');
	const previewSceneBreak = $derived(
		(data.pageSetup?.sceneBreak ?? '* * *').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
	);
	// The preview shows the prose at the page's text-column width, print font,
	// size, and line spacing, so line length and spacing match the export. (The
	// alternating spine gutter only shows in the paginated Print view.)
	const previewStyle = $derived.by(() => {
		let css = `--scene-break: "${previewSceneBreak}";`;
		const setup = data.pageSetup;
		if (setup) {
			css +=
				` max-width: ${contentWidthCss(setup)};` +
				` font-family: ${PAGE_FONTS[setup.font].css};` +
				` font-size: ${setup.fontSize}pt; line-height: ${lineHeight(setup)};`;
		}
		return css;
	});

	// Right column tabs; History holds the open scene's timeline. The Assistant
	// tab appears only when the account has it configured and switched on.
	let rightTab = $state<'reference' | 'history' | 'session' | 'assistant'>('reference');

	// An Assistant intent (from a menu here or the command palette) opens the
	// tab; the panel consumes the intent itself once it renders.
	$effect(() => {
		if (assistantIntent.pending && data.assistant.tabEnabled) rightTab = 'assistant';
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
		data.selectedScene ? `${storyPath}?scene=${data.selectedScene.id}` : storyPath
	);

	function chapterScenes(chapterId: string) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}

	// The sidebar filter: a matching chapter keeps all its scenes, otherwise
	// only matching scenes show, and a chapter with nothing left hides.
	// While filtering, chapters stay open and dragging is off.
	let sidebarQuery = $state('');
	const sceneQuery = $derived(sidebarQuery.trim().toLowerCase());
	function nameMatches(title: string | null, fallback: string) {
		return (title ?? fallback).toLowerCase().includes(sceneQuery);
	}
	const visibleOrphans = $derived(
		sceneQuery === ''
			? orphanScenes
			: orphanScenes.filter((scene) => nameMatches(scene.title, 'Untitled scene'))
	);

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
		  }
		| undefined
	> = $state({});

	function focusNeighbor(sceneId: string, direction: 'up' | 'down') {
		const index = docOrder.indexOf(sceneId);
		const target = docOrder[index + (direction === 'down' ? 1 : -1)];
		if (target) docEditors[target]?.focusEdge(direction === 'down' ? 'start' : 'end');
	}

	function words(count: number) {
		if (count <= 0) return '';
		return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
	}

	// Drag-to-reorder. The drop target is a chapter (or the orphan list, null)
	// plus an insertion index; on drop the full order is sent to the server,
	// which renumbers global_position and position_in_chapter.
	let draggingSceneId = $state<string | null>(null);
	let dropTarget = $state<{ chapterId: string | null; index: number } | null>(null);

	function overScene(event: DragEvent, chapterId: string | null, index: number) {
		if (!draggingSceneId) return;
		event.preventDefault();
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const after = event.clientY > rect.top + rect.height / 2;
		dropTarget = { chapterId, index: index + (after ? 1 : 0) };
	}

	function overChapterHeader(event: DragEvent, chapterId: string) {
		if (!draggingSceneId) return;
		event.preventDefault();
		dropTarget = { chapterId, index: chapterScenes(chapterId).length };
	}

	function buildOrder(sceneId: string, target: { chapterId: string | null; index: number }) {
		const chapterLists = data.chapters.map((chapter) => ({
			id: chapter.id,
			sceneIds: chapterScenes(chapter.id).map((scene) => scene.id)
		}));
		const orphanSceneIds = orphanScenes.map((scene) => scene.id);
		let index = target.index;
		for (const chapter of chapterLists) {
			const at = chapter.sceneIds.indexOf(sceneId);
			if (at !== -1) {
				chapter.sceneIds.splice(at, 1);
				if (chapter.id === target.chapterId && at < index) index -= 1;
			}
		}
		const orphanAt = orphanSceneIds.indexOf(sceneId);
		if (orphanAt !== -1) {
			orphanSceneIds.splice(orphanAt, 1);
			if (target.chapterId === null && orphanAt < index) index -= 1;
		}
		if (target.chapterId === null) {
			orphanSceneIds.splice(index, 0, sceneId);
		} else {
			chapterLists
				.find((chapter) => chapter.id === target.chapterId)
				?.sceneIds.splice(index, 0, sceneId);
		}
		return { chapters: chapterLists, orphanSceneIds };
	}

	async function commitDrop(event: DragEvent) {
		event.preventDefault();
		if (!draggingSceneId || !dropTarget) return;
		const order = buildOrder(draggingSceneId, { ...dropTarget });
		draggingSceneId = null;
		dropTarget = null;
		await fetch(`/api/stories/${data.story.id}/scene-order`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(order)
		});
		await invalidateAll();
	}

	function endDrag() {
		draggingSceneId = null;
		dropTarget = null;
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

<!-- Sidebar actions reload the page; carrying the open scene keeps it open. -->
{#snippet openSceneField()}
	{#if selectedSceneId}
		<input type="hidden" name="openSceneId" value={selectedSceneId} />
	{/if}
{/snippet}

<!-- Read-only render of the whole story through the export's markdown
     renderer, so the writer sees what an export looks like: no underlines,
     no markers, alignment and scene breaks applied. -->
{#snippet storyPreview()}
	<div class="md-editor">
		<div class="md-toolbar">
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a class="md-tool md-preview-edit" href={editStoryHref} title="Back to editing">
				<Icon name="pencil" size={15} />
				<span class="md-tool-label">Edit</span>
			</a>
			<div class="md-right">
				<span class="md-hint">Preview</span>
				<a class="md-tool" href={toggleHref} title="Back to the scene editor">
					<Icon name="scene" size={16} />
				</a>
				<button
					class="md-tool"
					type="button"
					title="Focus mode"
					onclick={() => (focusMode.on = true)}
				>
					<Icon name="expand" size={16} />
				</button>
			</div>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
		<div class="editor-scroll">
			<div class="editor story-preview" class:spaced={previewSpaced} style={previewStyle}>
				<h1 class="doc-title">{data.story.title}</h1>
				{#if (data.storyDoc ?? []).length === 0}
					<div class="empty">
						<p>Nothing written yet. Switch back to the editor to add scenes.</p>
					</div>
				{/if}
				{#each data.chapters as chapter, index (chapter.id)}
					{@const list = docScenes(chapter.id)}
					{#if list.length > 0}
						<section class="prev-chapter">
							<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
							{#each list as scene, si (scene.id)}
								{#if si > 0}<hr class="scene-break" />{/if}
								<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
								{@html renderMarkdown(scene.bodyMd)}
							{/each}
						</section>
					{/if}
				{/each}
				{#if docScenes(null).length > 0}
					<section class="prev-chapter">
						<h2>Unfiled scenes</h2>
						{#each docScenes(null) as scene, si (scene.id)}
							{#if si > 0}<hr class="scene-break" />{/if}
							<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
							{@html renderMarkdown(scene.bodyMd)}
						{/each}
					</section>
				{/if}
			</div>
		</div>
	</div>
{/snippet}

<div class="app" class:focus-mode={focusMode.on}>
	<TopBar
		universe={{ slug: data.universe.slug, name: data.universe.name }}
		story={{ slug: data.story.slug, title: data.story.title }}
		{saveStatus}
		help={{ topic: 'editor', label: 'the editor' }}
	/>
	<div class="body">
		<aside class="pane left">
			<div class="left-head">
				<ModeSwitcher
					active="write"
					hrefs={{
						plan: resolve('/stories/[id]/plan', { id: data.story.slug }),
						notes: resolve('/stories/[id]/notes', { id: data.story.slug }),
						review: resolve('/stories/[id]/review', { id: data.story.slug })
					}}
				/>
				<SidebarSearch bind:query={sidebarQuery} placeholder="Filter chapters and scenes..." />
			</div>
			<div class="left-scroll">
				<div class="outline">
					<div
						class="outline-head"
						use:dismiss={{ enabled: storyMenuOpen, close: () => (storyMenuOpen = false) }}
					>
						<!-- The book switcher: with more than one story in the
						     universe, the header opens a menu to jump between them. -->
						<button
							class="story-switch"
							type="button"
							disabled={data.storySiblings.length < 2}
							onclick={() => (storyMenuOpen = !storyMenuOpen)}
						>
							<span class="story-book"><Icon name="book" size={15} /></span>
							<span class="story-id">
								<span class="story-title">{data.story.title}</span>
								<span class="story-universe">{data.universe.name}</span>
							</span>
							{#if data.storySiblings.length > 1}
								<span class="story-caret" class:open={storyMenuOpen}>
									<Icon name="chevron" size={13} />
								</span>
							{/if}
						</button>
						{#if storyMenuOpen}
							<div class="story-menu">
								{#each data.storySiblings as sibling (sibling.id)}
									<button
										type="button"
										class:active={sibling.id === data.story.id}
										onclick={async () => {
											storyMenuOpen = false;
											if (sibling.id !== data.story.id) {
												// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path from an owned slug
												await goto(`/stories/${sibling.slug}`);
											}
										}}
									>
										<span class="sm-title">{sibling.title}</span>
										<span class="sm-sub">
											{sibling.chapters} chapter{sibling.chapters === 1 ? '' : 's'} · {words(
												sibling.words
											) || '0'} words
										</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="chapters">
						{#each data.chapters as chapter, index (chapter.id)}
							{@const chapterMatch =
								sceneQuery === '' || nameMatches(chapter.title, `Chapter ${index + 1}`)}
							{@const list = chapterMatch
								? chapterScenes(chapter.id)
								: chapterScenes(chapter.id).filter((scene) =>
										nameMatches(scene.title, 'Untitled scene')
									)}
							{@const open = sceneQuery !== '' || !collapsed.has(chapter.id)}
							{#if chapterMatch || list.length > 0}
								<div class="chapter">
									{#if renamingChapterId === chapter.id}
										<form class="chapter-rename" method="POST" action="?/renameChapter">
											<input type="hidden" name="chapterId" value={chapter.id} />
											{@render openSceneField()}
											<!-- svelte-ignore a11y_autofocus (the field only appears on the rename click) -->
											<input
												class="chapter-rename-input"
												name="title"
												value={chapter.title ?? ''}
												placeholder={`Chapter ${index + 1}`}
												autofocus
												onkeydown={(e) => {
													if (e.key === 'Escape') renamingChapterId = null;
												}}
											/>
											<button class="tool-btn" type="submit" title="Save chapter name">Save</button>
										</form>
									{:else}
										<button
											class="chapter-row"
											class:scene-target={dropTarget?.chapterId === chapter.id &&
												dropTarget.index === list.length &&
												!open}
											type="button"
											onclick={() =>
												collapsed.has(chapter.id)
													? collapsed.delete(chapter.id)
													: collapsed.add(chapter.id)}
											oncontextmenu={(e) =>
												openRowMenu(e, { kind: 'chapter', id: chapter.id, index })}
											ondragover={(e) => overChapterHeader(e, chapter.id)}
											ondrop={commitDrop}
										>
											<span class="tw" class:open><Icon name="chevron" size={12} /></span>
											<span class="chapter-name">{chapter.title ?? `Chapter ${index + 1}`}</span>
											<span class="chapter-meta">{list.length}</span>
										</button>
									{/if}
									{#if open}
										<div class="scenes">
											{#each list as scene, si (scene.id)}
												{#if dropTarget?.chapterId === chapter.id && dropTarget.index === si}
													<div class="drop-line scene"></div>
												{/if}
												<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
												<a
													class="scene-row"
													class:active={scene.id === data.selectedScene?.id}
													class:merge-selected={mergeSelection.has(scene.id)}
													href={viewStory ? `#scene-${scene.id}` : `${storyPath}?scene=${scene.id}`}
													draggable="true"
													oncontextmenu={(e) => openRowMenu(e, { kind: 'scene', id: scene.id })}
													ondragstart={(e) => {
														draggingSceneId = scene.id;
														e.dataTransfer?.setData('text/plain', scene.id);
													}}
													ondragover={(e) => overScene(e, chapter.id, si)}
													ondrop={commitDrop}
													ondragend={endDrag}
												>
													<span class="scene-status st-{scene.status}" title={scene.status}></span>
													<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
													{#if scene.wordCount > 0}
														<span class="scene-words">{words(scene.wordCount)}</span>
													{/if}
												</a>
												<!-- eslint-enable svelte/no-navigation-without-resolve -->
											{/each}
											{#if dropTarget?.chapterId === chapter.id && dropTarget.index === list.length && open}
												<div class="drop-line scene"></div>
											{/if}
											{#if sceneQuery === ''}
												<form method="POST" action="?/createScene">
													<input type="hidden" name="chapterId" value={chapter.id} />
													<button class="outline-add scene" type="submit">
														<Icon name="plus" size={12} /> New scene
													</button>
												</form>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						{/each}
						{#if visibleOrphans.length > 0}
							<div class="chapter">
								<span class="chapter-row as-label unfiled-head">
									<span class="chapter-name">Unfiled scenes</span>
									<span class="chapter-meta">{visibleOrphans.length}</span>
								</span>
								<div class="scenes">
									{#each visibleOrphans as scene, si (scene.id)}
										{#if dropTarget?.chapterId === null && dropTarget.index === si}
											<div class="drop-line scene"></div>
										{/if}
										<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
										<a
											class="scene-row"
											class:active={scene.id === data.selectedScene?.id}
											class:merge-selected={mergeSelection.has(scene.id)}
											href={viewStory ? `#scene-${scene.id}` : `${storyPath}?scene=${scene.id}`}
											draggable={sceneQuery === ''}
											oncontextmenu={(e) => openRowMenu(e, { kind: 'scene', id: scene.id })}
											ondragstart={(e) => {
												draggingSceneId = scene.id;
												e.dataTransfer?.setData('text/plain', scene.id);
											}}
											ondragover={(e) => overScene(e, null, si)}
											ondrop={commitDrop}
											ondragend={endDrag}
										>
											<span class="scene-status st-{scene.status}" title={scene.status}></span>
											<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
											{#if scene.wordCount > 0}
												<span class="scene-words">{words(scene.wordCount)}</span>
											{/if}
										</a>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									{/each}
									{#if dropTarget?.chapterId === null && dropTarget.index === visibleOrphans.length}
										<div class="drop-line scene"></div>
									{/if}
								</div>
							</div>
						{/if}
						{#if sceneQuery !== '' && visibleOrphans.length === 0 && !data.chapters.some((chapter, index) => nameMatches(chapter.title, `Chapter ${index + 1}`) || chapterScenes(chapter.id).some( (scene) => nameMatches(scene.title, 'Untitled scene') ))}
							<div class="search-empty">No chapters or scenes match.</div>
						{/if}
						{#if sceneQuery === ''}
							<form method="POST" action="?/createChapter">
								<button class="outline-add" type="submit">
									<Icon name="plus" size={13} /> New chapter
								</button>
							</form>
						{/if}
						{#if sceneQuery === '' && data.trashedScenes.length > 0}
							<div class="chapter trash">
								<button class="chapter-row" type="button" onclick={() => (trashOpen = !trashOpen)}>
									<span class="tw" class:open={trashOpen}><Icon name="chevron" size={12} /></span>
									<span class="chapter-name">Deleted scenes</span>
									<span class="chapter-meta">{data.trashedScenes.length}</span>
								</button>
								{#if trashOpen}
									<div class="scenes">
										{#each data.trashedScenes as scene (scene.id)}
											<div class="trash-row">
												<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
												{#if scene.wordCount > 0}
													<span class="scene-words">{words(scene.wordCount)}</span>
												{/if}
												<form method="POST" action="?/restoreScene">
													<input type="hidden" name="sceneId" value={scene.id} />
													<button class="tool-btn" type="submit" title="Restore scene">
														<Icon name="restore" size={12} />
													</button>
												</form>
												<form
													method="POST"
													action="?/destroyScene"
													onsubmit={(e) => {
														if (
															!confirm(
																'Delete this scene forever? It cannot be restored after this.'
															)
														)
															e.preventDefault();
													}}
												>
													<input type="hidden" name="sceneId" value={scene.id} />
													{@render openSceneField()}
													<button class="tool-btn danger" type="submit" title="Delete forever">
														<Icon name="trash" size={12} />
													</button>
												</form>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</aside>
		<main class="pane center">
			{#if viewStory}
				{#snippet docScene(scene: NonNullable<typeof data.storyDoc>[number])}
					<article class="doc-scene" id="scene-{scene.id}">
						{#if data.preferences.continuousSceneMarks === 'shown'}
							<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
							<a
								class="doc-scene-mark"
								href={`${storyPath}?scene=${scene.id}`}
								title="Edit this scene alone"
							>
								{scene.title ?? 'Untitled scene'}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
						<SceneEditor
							bind:this={docEditors[scene.id]}
							compact
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
								if (status === 'saved') void invalidateAll();
							}}
						/>
					</article>
				{/snippet}
				<div class="md-editor">
					<EditorToolbar
						view={toolbarView}
						{previewHref}
						storyView={{ active: inWholeStory, toggleHref }}
						nonPrintingActive={nonPrintingMarks === 'shown'}
						onToggleNonPrinting={toggleNonPrinting}
						commandMarkersActive={commandMarkers === 'shown'}
						onToggleCommandMarkers={toggleCommandMarkers}
						onEnterFocus={() => (focusMode.on = true)}
					/>
					<div class="editor-scroll">
						<div class="editor story-doc">
							<h1 class="doc-title">{data.story.title}</h1>
							{#if (data.storyDoc ?? []).length === 0}
								<div class="empty">
									<p>Nothing written yet. Switch back to the editor to add scenes.</p>
								</div>
							{/if}
							{#each data.chapters as chapter, index (chapter.id)}
								{@const docList = docScenes(chapter.id)}
								{#if docList.length > 0}
									<section class="doc-chapter" id="chapter-{chapter.id}">
										<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
										{#each docList as scene (scene.id)}
											{@render docScene(scene)}
										{/each}
									</section>
								{/if}
							{/each}
							{#if docScenes(null).length > 0}
								<section class="doc-chapter">
									<h2>Unfiled scenes</h2>
									{#each docScenes(null) as scene (scene.id)}
										{@render docScene(scene)}
									{/each}
								</section>
							{/if}
						</div>
					</div>
				</div>
			{:else if viewPreview}
				{@render storyPreview()}
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
				{#key data.selectedScene.id}
					<SceneEditor
						bind:this={sceneEditor}
						onSplitScene={splitCurrentScene}
						storyView={{ active: inWholeStory, toggleHref }}
						previewHref={`${storyPath}?view=preview&scene=${data.selectedScene.id}`}
						{nonPrintingMarks}
						{commandMarkers}
						onToggleNonPrinting={toggleNonPrinting}
						onToggleCommandMarkers={toggleCommandMarkers}
						onEnterFocus={() => (focusMode.on = true)}
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
								void invalidateAll();
							}
						}}
					/>
				{/key}
			{:else if data.scenes.length === 0}
				<div class="empty">
					<p>Create a chapter in the sidebar, then add a scene to it to start writing.</p>
				</div>
			{:else}
				<div class="empty">
					<p>Select a scene in the sidebar.</p>
				</div>
			{/if}
		</main>
		<aside class="pane right">
			{#if inspectStack.length > 0}
				{#if inspectCard}
					<EntityCard
						card={inspectCard}
						onBack={backCard}
						onOpen={openCard}
						planHref={`${resolve('/stories/[id]/plan', { id: data.story.slug })}?entity=${inspectCard.id}`}
					/>
				{:else}
					<div class="empty">Loading...</div>
				{/if}
			{:else}
				<div class="right-head">
					<div class="rtabs">
						{#if data.selectedScene}
							<button
								class="rtab"
								class:active={rightTab === 'reference'}
								type="button"
								onclick={() => (rightTab = 'reference')}
							>
								Reference
							</button>
							<button
								class="rtab"
								class:active={rightTab === 'history'}
								type="button"
								onclick={() => (rightTab = 'history')}
							>
								History
							</button>
						{/if}
						<button
							class="rtab"
							class:active={rightTab === 'session'}
							type="button"
							onclick={() => (rightTab = 'session')}
						>
							Session
						</button>
						{#if data.assistant.tabEnabled}
							<button
								class="rtab"
								class:active={rightTab === 'assistant'}
								type="button"
								onclick={() => (rightTab = 'assistant')}
							>
								Assistant
							</button>
						{/if}
					</div>
				</div>
				{#if rightTab === 'assistant' && data.assistant.tabEnabled}
					<AssistantPanel
						storyId={data.story.id}
						sceneId={data.selectedScene?.id ?? null}
						name={data.assistant.name}
						storyTitle={data.story.title}
						muted={data.assistant.muted}
						suggestions={assistantSuggestions}
						initialMessages={data.assistantChat}
						onConfirmSplit={confirmAssistantSplit}
						onRevertSplit={revertAssistantSplit}
						onInsert={data.selectedScene && !inWholeStory && !data.revisionPreview
							? (text) => sceneEditor?.insertAtCursor(text)
							: undefined}
					/>
				{:else if rightTab === 'session'}
					<SessionPanel universeSlug={data.universe.slug} storyId={data.story.id} />
				{:else if data.selectedScene && rightTab === 'history'}
					<RevisionHistory
						entityType="scene"
						entityId={data.selectedScene.id}
						revisions={data.sceneRevisions}
						previewId={data.revisionPreview?.id}
						previewHref={(revisionId) => `${sceneHref}&revision=${revisionId}`}
					/>
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
												onclick={async () => {
													await fetch(`/api/markers/${todo.markerId}`, {
														method: 'PUT',
														headers: { 'content-type': 'application/json' },
														body: JSON.stringify({ resolved: true })
													});
													await invalidateAll();
												}}
											></button>
										{:else}
											<span class="todo-dot" title="A TODO: line; delete it when done"></span>
										{/if}
										<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
										<a class="todo-text" href={`${storyPath}?scene=${todo.sceneId}`}>
											{todo.text}
											<span class="todo-scene">{todo.sceneTitle ?? 'Untitled scene'}</span>
										</a>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									</div>
								{/each}
								<div class="todo-hint">
									Write a line starting with TODO:, or select prose and press Ctrl+Alt+M.
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
							<div class="empty">Nothing to show yet.</div>
						{/if}
					</div>
				{/if}
			{/if}
		</aside>
	</div>

	{#if focusMode.on}
		<div class="focus-controls">
			<ThemeToggle />
			<button
				class="icon-btn"
				type="button"
				title="Exit focus (Esc)"
				onclick={() => (focusMode.on = false)}
			>
				<Icon name="compress" />
			</button>
		</div>
	{/if}
</div>

{#if rowMenu}
	{@const target = rowMenu.target}
	<div
		class="row-menu"
		role="menu"
		tabindex="-1"
		bind:this={rowMenuEl}
		use:dismiss={{ close: () => (rowMenu = null) }}
		onkeydown={onRowMenuKey}
		style="left: {rowMenu.x}px; top: {rowMenu.y}px;"
	>
		{#if target.kind === 'chapter'}
			<button
				class="row-menu-item"
				type="button"
				role="menuitem"
				onclick={() => {
					renamingChapterId = target.id;
					rowMenu = null;
				}}
			>
				<Icon name="pencil" size={13} /> Rename chapter
			</button>
			{#if data.assistant.surfacesEnabled}
				<div
					class="row-sub"
					role="presentation"
					onmouseenter={() => (rowSubOpen = true)}
					onmouseleave={() => (rowSubOpen = false)}
				>
					<button
						class="row-menu-item row-sub-trigger"
						type="button"
						role="menuitem"
						aria-haspopup="menu"
						aria-expanded={rowSubOpen}
						onclick={() => (rowSubOpen = !rowSubOpen)}
					>
						<span class="row-sub-label"><Icon name="sparkles" size={13} /> Assistant</span>
						<Icon name="chevron" size={12} />
					</button>
					{#if rowSubOpen}
						<div class="row-submenu" role="menu">
							<button
								class="row-menu-item"
								type="button"
								role="menuitem"
								onclick={() => reviewChapter(target.id)}
							>
								Review this chapter
							</button>
						</div>
					{/if}
				</div>
			{/if}
			<form method="POST" action="?/moveChapter">
				<input type="hidden" name="chapterId" value={target.id} />
				<input type="hidden" name="direction" value="up" />
				{@render openSceneField()}
				<button
					class="row-menu-item turn-up"
					type="submit"
					role="menuitem"
					disabled={target.index === 0}
				>
					<Icon name="chevron" size={13} /> Move up
				</button>
			</form>
			<form method="POST" action="?/moveChapter">
				<input type="hidden" name="chapterId" value={target.id} />
				<input type="hidden" name="direction" value="down" />
				{@render openSceneField()}
				<button
					class="row-menu-item turn-down"
					type="submit"
					role="menuitem"
					disabled={target.index === data.chapters.length - 1}
				>
					<Icon name="chevron" size={13} /> Move down
				</button>
			</form>
			<form
				method="POST"
				action="?/deleteChapter"
				onsubmit={(e) => {
					if (!confirm('Delete this chapter? Its scenes move to Unfiled scenes.'))
						e.preventDefault();
				}}
			>
				<input type="hidden" name="chapterId" value={target.id} />
				{@render openSceneField()}
				<button class="row-menu-item danger" type="submit" role="menuitem">
					<Icon name="trash" size={13} /> Delete chapter
				</button>
			</form>
		{:else}
			{@const pickedForMerge = mergeSelection.has(target.id)}
			<button
				class="row-menu-item"
				type="button"
				role="menuitem"
				onclick={() => toggleMergeSelection(target.id)}
			>
				<Icon name="plus" size={13} />
				{pickedForMerge ? 'Unselect for merging' : 'Select for merging'}
			</button>
			<button
				class="row-menu-item"
				type="button"
				role="menuitem"
				onclick={() => duplicateScene(target.id)}
			>
				<Icon name="copy" size={13} /> Duplicate scene
			</button>
			{#if data.assistant.surfacesEnabled}
				<div
					class="row-sub"
					role="presentation"
					onmouseenter={() => (rowSubOpen = true)}
					onmouseleave={() => (rowSubOpen = false)}
				>
					<button
						class="row-menu-item row-sub-trigger"
						type="button"
						role="menuitem"
						aria-haspopup="menu"
						aria-expanded={rowSubOpen}
						onclick={() => (rowSubOpen = !rowSubOpen)}
					>
						<span class="row-sub-label"><Icon name="sparkles" size={13} /> Assistant</span>
						<Icon name="chevron" size={12} />
					</button>
					{#if rowSubOpen}
						<div class="row-submenu" role="menu">
							<button
								class="row-menu-item"
								type="button"
								role="menuitem"
								onclick={() => reviewScene(target.id)}
							>
								Review this scene
							</button>
							<button
								class="row-menu-item"
								type="button"
								role="menuitem"
								onclick={() => suggestSplit(target.id)}
							>
								Suggest where to split
							</button>
						</div>
					{/if}
				</div>
			{/if}
			{#if pickedForMerge && mergeSelection.size >= 2}
				<button class="row-menu-item" type="button" role="menuitem" onclick={mergeSelectedScenes}>
					<Icon name="chapter" size={13} /> Merge {mergeSelection.size} scenes
				</button>
			{/if}
			{#if mergeSelection.size > 0}
				<button
					class="row-menu-item"
					type="button"
					role="menuitem"
					onclick={() => {
						mergeSelection.clear();
						rowMenu = null;
					}}
				>
					Clear merge selection
				</button>
			{/if}
			<form method="POST" action="?/deleteScene">
				<input type="hidden" name="sceneId" value={target.id} />
				{@render openSceneField()}
				<button class="row-menu-item danger" type="submit" role="menuitem">
					<Icon name="trash" size={13} /> Delete scene
				</button>
			</form>
		{/if}
	</div>
{/if}

{#if reviewingScene}
	<div class="assistant-review-busy" role="status" aria-live="polite">
		<span class="arb-dot"></span> The Assistant is reviewing this scene...
	</div>
{/if}

<style>
	.assistant-review-busy {
		position: fixed;
		bottom: 18px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 8px 16px;
		font-size: 13px;
		color: var(--text);
		box-shadow: var(--shadow);
	}
	.arb-dot {
		width: 8px;
		height: 8px;
		border-radius: 99px;
		background: var(--accent);
		animation: arb-pulse 1.1s infinite;
	}
	@keyframes arb-pulse {
		0%,
		100% {
			opacity: 0.3;
		}
		50% {
			opacity: 1;
		}
	}
	/* A scene picked for merging keeps a quiet accent ring until the merge
	   or the selection is cleared. */
	.scene-row.merge-selected {
		box-shadow: inset 0 0 0 1.5px var(--accent-line);
		border-radius: 6px;
	}

	/* The sidebar rows' right-click menu; same look as the editor's
	   selection menu. */
	.row-menu {
		position: fixed;
		z-index: 60;
		min-width: 170px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
	}
	.row-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		padding: 6px 7px;
		border-radius: 5px;
		/* Native context menus keep the arrow cursor; match them. */
		cursor: default;
	}
	.row-menu-item:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	/* The Assistant flyout, the editor selection menu's submenu pattern. */
	.row-sub {
		position: relative;
	}
	.row-sub-trigger {
		justify-content: space-between;
	}
	.row-sub-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.row-submenu {
		position: absolute;
		left: calc(100% - 2px);
		top: -7px;
		min-width: 180px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
		z-index: 61;
	}
	.row-menu-item:disabled {
		color: var(--text-faint);
	}
	.row-menu-item.danger:hover:not(:disabled) {
		color: var(--danger, #c0564f);
	}
	.row-menu-item.turn-up :global(svg) {
		transform: rotate(-90deg);
	}
	.row-menu-item.turn-down :global(svg) {
		transform: rotate(90deg);
	}
	.chapter-row {
		width: 100%;
		border: 0;
		background: none;
		text-align: left;
	}
	/* The button reset above outranks the theme's hover by cascade order,
	   so restate it. */
	.chapter-row:hover {
		background: var(--bg-hover);
	}
	.chapter-row.as-label:hover {
		background: none;
	}
	.scene-row {
		text-decoration: none;
		color: inherit;
	}
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
		color: var(--accent);
	}
	/* Read-only preview: prose through the export renderer, styled to read
	   like the finished book. */
	.md-preview-edit {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		text-decoration: none;
		color: var(--text-muted);
	}
	.md-preview-edit:hover {
		color: var(--text);
	}
	.md-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.md-right .md-hint {
		margin-left: 0;
	}
	.story-preview {
		font-family: var(--font-content);
		line-height: 1.7;
	}
	.prev-chapter h2 {
		font-family: var(--font-content);
		font-size: 23px;
		font-weight: 600;
		text-align: center;
		margin: 40px 0 20px;
	}
	.story-preview :global(p) {
		margin: 0 0 0.2rem;
		text-indent: 1.5em;
	}
	.story-preview.spaced :global(p) {
		margin: 0 0 0.85em;
		text-indent: 0;
	}
	/* Centered and right-aligned paragraphs drop the indent, as in the export. */
	.story-preview :global(p.align-center) {
		text-align: center;
		text-indent: 0;
	}
	.story-preview :global(p.align-right) {
		text-align: right;
		text-indent: 0;
	}
	.story-preview :global(p.align-justify) {
		text-align: justify;
	}
	.story-preview :global(img) {
		max-width: 100%;
	}
	.scene-break {
		border: 0;
		text-align: center;
		margin: 2rem 0;
	}
	.scene-break::after {
		content: var(--scene-break, '* * *');
		color: var(--text-faint);
	}
	.story-preview :global(.page-break) {
		border-top: 1px dashed var(--border);
		margin: 2.5rem 0;
	}
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
		border: 1.5px solid var(--cat-amber, #b8860b);
		border-radius: 4px;
		background: none;
		cursor: pointer;
	}
	.todo-check:hover {
		background: color-mix(in oklab, var(--cat-amber, #b8860b) 30%, transparent);
	}
	.todo-dot {
		width: 14px;
		height: 14px;
		margin-top: 2px;
		flex: none;
		border-radius: 99px;
		background: color-mix(in oklab, var(--cat-amber, #b8860b) 35%, transparent);
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
