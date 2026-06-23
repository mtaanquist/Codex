<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import SidebarSearch from './SidebarSearch.svelte';
	import StoryOutline from './StoryOutline.svelte';
	import StoryRowMenu, { type RowMenuState, type RowMenuTarget } from './StoryRowMenu.svelte';
	import ReviewSurface from './ReviewSurface.svelte';
	import ReviewEditor from './ReviewEditor.svelte';
	import ReviewPanel from './ReviewPanel.svelte';
	import type { Composer } from './ReviewPanel.svelte';
	import AssistantPanel from './AssistantPanel.svelte';
	import type { SplitProposal } from './AssistantProposal.svelte';
	import type { MentionEntity } from '$lib/editor-mentions';
	import type { MarkVisibility } from '$lib/editor';
	import {
		suggestionInFilter,
		threadInFilter,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '$lib/review-ui';
	import type { SaveStatus } from './SceneEditor.svelte';
	import type { ViewItem } from './ViewMenu.svelte';
	import ModeSwitcher from './ModeSwitcher.svelte';
	import {
		duplicateScene as duplicateSceneAction,
		mergeScenes as mergeScenesAction
	} from '$lib/scene-actions';
	import { focusMode } from '$lib/focus-mode.svelte';
	import { openReviewModal } from '$lib/review-modal.svelte';

	let {
		chapters,
		scenes,
		trashedScenes = [],
		threads,
		suggestions,
		role,
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
		assistantChat = [],
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
		// The owning story; the author's editable centre autosaves against it.
		storyId?: string | null;
		// The story slug, for the View dropdown's links to Preview and Print.
		storySlug?: string | null;
		// The book header above the outline (title plus universe); null hides it.
		book?: { title: string; subtitle: string | null } | null;
		canSuggest?: boolean;
		// The mode switcher links, shown on the author side only.
		seg?: { writeHref: string; planHref: string; notesHref: string } | null;
		// Entity mention data for the centre's highlights and quick cards.
		entities?: MentionEntity[];
		mentionMembers?: string[];
		mentionPins?: Record<string, string>;
		entityHref?: ((entity: MentionEntity) => string) | null;
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
		// The stored Assistant conversation, seeding the Assistant tab's chat.
		assistantChat?: {
			role: 'user' | 'assistant';
			content: string;
			meta: {
				reference?: { sceneId: string; text: string };
				proposals?: Omit<SplitProposal, 'confirming' | 'error'>[];
			} | null;
		}[];
		// The author editor's autosave feedback, surfaced in the page's TopBar.
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
		await invalidateAll();
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
	let mobileTab = $state<'nav' | 'read' | 'notes'>('read');
	// The right pane toggles between the notes (Review) and the chat (Assistant),
	// shown only when the Assistant tab is available for this story.
	let rightTab = $state<'review' | 'assistant'>('review');
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
	// is plain state, a data refresh (invalidateAll leaves the URL alone) keeps
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

	// The View dropdown for the editable centre, the same control as the Write
	// toolbar: Edit (here), Preview and Print (the export views), and a
	// distraction-free Focus that hides the side panes.
	const storyHref = $derived(storySlug ? resolve('/stories/[id]', { id: storySlug }) : '');
	const viewMenu = $derived<ViewItem[]>(
		storyHref
			? [
					{ id: 'edit', label: 'Edit', icon: 'pencil', current: true },
					{
						id: 'preview',
						label: 'Preview',
						icon: 'book',
						href: `${storyHref}?view=preview&scene=${selectedSceneId}`
					},
					{ id: 'focus', label: 'Focus', icon: 'expand', onSelect: () => (focusMode.on = true) },
					{ id: 'print', label: 'Print', icon: 'print', href: `${storyHref}/print` }
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

	function selectScene(id: string) {
		if (id !== selectedSceneId) {
			chosenSceneId = id;
			composer = null;
		}
	}

	function navSelectScene(sceneId: string) {
		selectScene(sceneId);
		// Picking a scene from the outline shows the manuscript on mobile.
		mobileTab = 'read';
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

	// Copies a scene in full directly after itself; the new scene becomes the one
	// under review.
	async function duplicateScene(sceneId: string) {
		rowMenu = null;
		if (!storyId) return;
		const result = await duplicateSceneAction(storyId, sceneId);
		if (!result.ok) {
			alert(result.message);
			return;
		}
		chosenSceneId = result.newSceneId;
		await invalidateAll();
	}

	// Joins the picked scenes in story order; the survivor becomes the open scene.
	async function mergeSelectedScenes() {
		rowMenu = null;
		if (!storyId) return;
		const result = await mergeScenesAction(storyId, [...mergeSelection]);
		if (!result.ok) {
			alert(result.message);
			return;
		}
		mergeSelection.clear();
		chosenSceneId = result.targetSceneId;
		await invalidateAll();
	}

	// Clicking a card jumps to its passage; clicking a mark jumps to its note.
	// On mobile that means switching to the pane the target lives in.
	function focusFromPanel(id: string | null) {
		focusedId = id;
		mobileTab = 'read';
	}
	function focusFromSurface(id: string | null) {
		focusedId = id;
		mobileTab = 'notes';
	}

	function openComposer(c: Composer) {
		composer = c;
		// The composer lives in the right panel; show it on mobile.
		mobileTab = 'notes';
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
	<nav class="rv-mtabs" aria-label="Review sections">
		<button
			class="rv-mtab"
			class:active={mobileTab === 'nav'}
			type="button"
			onclick={() => (mobileTab = 'nav')}
		>
			Scenes
		</button>
		<button
			class="rv-mtab"
			class:active={mobileTab === 'read'}
			type="button"
			onclick={() => (mobileTab = 'read')}
		>
			Manuscript
		</button>
		<button
			class="rv-mtab"
			class:active={mobileTab === 'notes'}
			type="button"
			onclick={() => (mobileTab = 'notes')}
		>
			Notes{#if sceneOpen > 0}<span class="rv-mtab-n">{sceneOpen}</span>{/if}
		</button>
	</nav>
	<div class="body" data-mtab={mobileTab}>
		<aside class="pane left">
			<div class="left-head">
				<!-- A reviewer stays in review mode; the other views are out of reach. -->
				<ModeSwitcher
					active="review"
					hrefs={seg
						? { write: seg.writeHref, plan: seg.planHref, notes: seg.notesHref }
						: { write: 'disabled', plan: 'disabled', notes: 'disabled' }}
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

		<main class="pane center">
			{#if selectedScene}
				{#key selectedScene.id}
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
				<div class="rv-empty-scene">This story has no scenes to review yet.</div>
			{/if}
		</main>

		<aside class="pane right">
			{#if assistantTab}
				<div class="rv-rhead">
					<div class="rtabs">
						<button
							class="rtab"
							class:active={rightTab === 'review'}
							type="button"
							onclick={() => (rightTab = 'review')}
						>
							Review
						</button>
						<button
							class="rtab"
							class:active={rightTab === 'assistant'}
							type="button"
							onclick={() => (rightTab = 'assistant')}
						>
							Assistant
						</button>
					</div>
				</div>
			{/if}
			<div class="rv-right-body">
				{#if assistantTab && rightTab === 'assistant'}
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
						<AssistantPanel
							scope={{ storyId: storyId ?? '', storyTitle: book?.title ?? '' }}
							sceneId={selectedSceneId || null}
							name={assistant?.name ?? 'Assistant'}
							muted={assistant?.muted ?? false}
							suggestions={assistantSuggestions}
							initialMessages={assistantChat}
						/>
					</div>
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
						onAccepted={role === 'author' ? (ids) => editorRef?.applyAccepted(ids) : null}
						assistant={assistantSurfaces ? { name: assistant?.name ?? 'Assistant' } : null}
						onAssistantReply={assistantSurfaces ? assistantReply : null}
					/>
				{/if}
			</div>
		</aside>
	</div>
</div>

{#if manage && rowMenu}
	<StoryRowMenu
		menu={rowMenu}
		chapterCount={chapters.length}
		assistantEnabled={false}
		{selectedSceneId}
		{mergeSelection}
		onClose={closeRowMenu}
		onRenameChapter={(id) => {
			renamingChapterId = id;
			rowMenu = null;
		}}
		onOpenReview={() => {}}
		onSuggestSplit={() => {}}
		onDuplicateScene={duplicateScene}
		onMergeSelected={mergeSelectedScenes}
	/>
{/if}

<style>
	/* The right pane stacks an optional tab strip over the active panel. */
	.rv-rhead {
		flex: none;
		padding: 8px;
		border-bottom: 1px solid var(--border);
	}
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
