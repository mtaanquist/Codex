<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { focusMode } from '$lib/focus-mode.svelte';
	import { assistantIntent } from '$lib/assistant.svelte';
	import { openReviewModal } from '$lib/review-modal.svelte';
	import ReviewModal from '$lib/components/ReviewModal.svelte';
	import EntityBadge from '$lib/components/EntityBadge.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import StoryPreview from '$lib/components/StoryPreview.svelte';
	import { editorStyleVars } from '$lib/page-setup';
	import type { ViewItem } from '$lib/components/ViewMenu.svelte';
	import StoryOutline from '$lib/components/StoryOutline.svelte';
	import StoryRowMenu, {
		type RowMenuState,
		type RowMenuTarget
	} from '$lib/components/StoryRowMenu.svelte';
	import {
		duplicateScene as duplicateSceneAction,
		mergeScenes as mergeScenesAction,
		persistProposalState,
		splitScene as splitSceneAction
	} from '$lib/scene-actions';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import EntityCard from '$lib/components/EntityCard.svelte';
	import type { EntityCardData } from '$lib/wire-types';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import SceneEditor, { type SaveStatus } from '$lib/components/SceneEditor.svelte';
	import type { EditorView } from '@codemirror/view';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import SessionPanel from '$lib/components/SessionPanel.svelte';
	import AssistantPanel from '$lib/components/AssistantPanel.svelte';
	import SidebarSearch from '$lib/components/SidebarSearch.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { PageData, Snapshot } from './$types';
	import ModeSwitcher from '$lib/components/ModeSwitcher.svelte';
	import { apiErrorMessage } from '$lib/format';
	import {
		toggleCommandMarkers as toggleCommandMarkersView,
		toggleNonPrintingMarks
	} from '$lib/editor-view';

	let { data }: { data: PageData } = $props();

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

	async function mergeSelectedScenes() {
		rowMenu = null;
		const result = await mergeScenesAction(data.story.id, [...mergeSelection]);
		if (!result.ok) {
			alert(result.message);
			return;
		}
		mergeSelection.clear();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${result.targetSceneId}`, { invalidateAll: true });
	}

	// Copies a scene in full directly after itself; useful for keeping a
	// scene as a reusable template.
	async function duplicateScene(sceneId: string) {
		rowMenu = null;
		const result = await duplicateSceneAction(data.story.id, sceneId);
		if (!result.ok) {
			alert(result.message);
			return;
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${result.newSceneId}`, { invalidateAll: true });
	}

	// Opens the review modal for a scene or chapter from the sidebar row menu;
	// the modal drives the run and reports progress in the activity center.
	function openReviewFor(request: { sceneId?: string; chapterId?: string }) {
		rowMenu = null;
		openReviewModal({
			level: request.sceneId ? 'scene' : 'chapter',
			sceneId: request.sceneId,
			chapterId: request.chapterId
		});
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
		const result = await splitSceneAction(data.selectedScene.id, { offset: cursor.offset });
		if (!result.ok) {
			alert(result.message);
			return;
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${result.newSceneId}`, { invalidateAll: true });
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
		const editor =
			data.selectedScene?.id === proposal.sceneId ? sceneEditor : docEditors[proposal.sceneId];
		await editor?.flushSave();
		const result = await splitSceneAction(proposal.sceneId, { before: proposal.before });
		if (!result.ok) return { error: result.message };
		const { newSceneId, splitSceneId } = result;
		persistProposalState(data.story.id, proposal, { splitSceneId, newSceneId });
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
		const result = await mergeScenesAction(data.story.id, [
			proposal.confirmed.splitSceneId,
			proposal.confirmed.newSceneId
		]);
		if (!result.ok) return result.message;
		persistProposalState(data.story.id, proposal, null);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		await goto(`${storyPath}?scene=${result.targetSceneId}`, { invalidateAll: true });
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

	// The default scene-editor URL, the Edit target from the scene toolbar.
	const sceneEditHref = $derived(
		data.returnSceneId ? `${storyPath}?scene=${data.returnSceneId}` : storyPath
	);
	// The View dropdown shared by every toolbar: Edit, Preview, Focus, Print.
	// The Edit and Preview targets differ by scope (whole story vs the open
	// scene), so they are passed in.
	function viewItems(editTarget: string, previewTarget: string): ViewItem[] {
		return [
			{ id: 'edit', label: 'Edit', icon: 'pencil', href: editTarget, current: !viewPreview },
			{ id: 'preview', label: 'Preview', icon: 'book', href: previewTarget, current: viewPreview },
			{ id: 'focus', label: 'Focus', icon: 'expand', onSelect: () => (focusMode.on = true) },
			{ id: 'print', label: 'Print', icon: 'print', href: `${storyPath}/print` }
		];
	}

	// The continuous view's one formatting bar acts on whichever stitched
	// editor last held the caret; default to the first so the bar is live
	// before the writer clicks in.
	let activeDocId = $state<string | null>(null);
	const toolbarView = () => docEditors[activeDocId ?? docOrder[0]]?.getView();

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
		  }
		| undefined
	> = $state({});

	function focusNeighbor(sceneId: string, direction: 'up' | 'down') {
		const index = docOrder.indexOf(sceneId);
		const target = docOrder[index + (direction === 'down' ? 1 : -1)];
		if (target) docEditors[target]?.focusEdge(direction === 'down' ? 'start' : 'end');
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
								if (status === 'saved') void invalidateAll();
							}}
						/>
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
				{#key data.selectedScene.id}
					<SceneEditor
						bind:this={sceneEditor}
						{editorStyle}
						onSplitScene={splitCurrentScene}
						storyView={{ active: inWholeStory, toggleHref }}
						viewMenu={viewItems(
							sceneEditHref,
							`${storyPath}?view=preview&scene=${data.selectedScene.id}`
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
		color: var(--accent);
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
