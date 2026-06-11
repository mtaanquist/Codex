<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Icon from './Icon.svelte';
	import SidebarSearch from './SidebarSearch.svelte';
	import ReviewNav from './ReviewNav.svelte';
	import ReviewSurface from './ReviewSurface.svelte';
	import ReviewEditor from './ReviewEditor.svelte';
	import ReviewPanel from './ReviewPanel.svelte';
	import type { Composer } from './ReviewPanel.svelte';
	import type { MentionEntity } from '$lib/editor-mentions';
	import type { MarkVisibility } from '$lib/editor';
	import type { ReviewFilter, ReviewSuggestion, ReviewThread } from '$lib/review-ui';
	import type { SaveStatus } from './SceneEditor.svelte';
	import ModeSwitcher from './ModeSwitcher.svelte';

	let {
		chapters,
		scenes,
		threads,
		suggestions,
		role,
		storyId = null,
		book = null,
		canSuggest = true,
		seg = null,
		entities = [],
		mentionMembers = [],
		mentionPins = {},
		entityHref = null,
		nonPrintingMarks = 'hidden',
		commandMarkers = 'shown',
		assistant = null,
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
		threads: ReviewThread[];
		suggestions: ReviewSuggestion[];
		role: 'author' | 'guest';
		// The owning story; the author's editable centre autosaves against it.
		storyId?: string | null;
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
		// Set on the author page when the Assistant is live for this story: a
		// reply in a thread the Assistant opened triggers its answer. Never set
		// on the guest page.
		assistant?: { name: string } | null;
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

	// Default to the first scene that has open activity, else the first scene.
	const firstActive = $derived(
		orderedScenes.find(
			(s) =>
				standaloneThreads.some((t) => t.sceneId === s.id && t.resolvedAt === null) ||
				suggestions.some((su) => su.sceneId === s.id && su.status === 'pending')
		)?.id
	);
	let chosenSceneId = $state<string | null>(null);
	const selectedSceneId = $derived(chosenSceneId ?? firstActive ?? orderedScenes[0]?.id ?? '');
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
				{#if book}
					<div class="outline-head">
						<span class="story-switch as-label">
							<span class="story-book"><Icon name="book" size={15} /></span>
							<span class="story-id">
								<span class="story-title">{book.title}</span>
								{#if book.subtitle}<span class="story-universe">{book.subtitle}</span>{/if}
							</span>
						</span>
					</div>
				{/if}
				<ReviewNav
					{chapters}
					scenes={orderedScenes}
					threads={standaloneThreads}
					{suggestions}
					{filter}
					{selectedSceneId}
					onSelect={navSelectScene}
					{query}
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
			{#if selectedScene}
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
					{assistant}
					onAssistantReply={assistant ? assistantReply : null}
				/>
			{/if}
		</aside>
	</div>
</div>
