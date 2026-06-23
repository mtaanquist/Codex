<script lang="ts" module>
	// Re-exported from the shared autosave queue so existing imports stand.
	import type { SaveStatus as AutosaveStatus } from '$lib/autosave';
	export type SaveStatus = AutosaveStatus;
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { createAutosave } from '$lib/autosave';
	import { invalidateAll } from '$app/navigation';
	import { EditorView, keymap } from '@codemirror/view';
	import { Compartment, EditorState, Prec } from '@codemirror/state';
	import {
		proseExtensions,
		commandMarkerExtensions,
		nonPrintingFor,
		type EditingMode,
		type MarkVisibility
	} from '$lib/editor';
	import { mentionExtensions, type MentionEntity, type MentionOptions } from '$lib/editor-mentions';
	import { autocompleteExtensions, type AutocompleteMode } from '$lib/editor-autocomplete';
	import { continuationExtensions } from '$lib/editor-continuation';
	import { imageUploadExtension } from '$lib/editor-images';
	import { markerExtensions, type MarkerHandle, type SceneMarker } from '$lib/editor-markers';
	import EditorToolbar from './EditorToolbar.svelte';
	import CoauthorPanel from './CoauthorPanel.svelte';
	import SelectionMenu from './SelectionMenu.svelte';
	import type { ViewItem } from './ViewMenu.svelte';

	let {
		sceneId,
		storyId,
		title,
		body,
		entities = [],
		mentionOptions = {},
		assistantContinuation = false,
		autocompleteMode = 'popup',
		editingMode = 'markdown',
		spellCheck = 'off',
		writingLanguage = '',
		markers = [],
		imageUniverseId,
		findText = null,
		findAt = null,
		compact = false,
		editorStyle,
		loreCategories = [],
		onCrossBoundary,
		onCreateEntity,
		onAskAssistant,
		onSplitScene,
		onFocus,
		storyView,
		viewMenu,
		nonPrintingMarks = 'hidden',
		commandMarkers = 'shown',
		onToggleNonPrinting,
		onToggleCommandMarkers,
		onStatus
	}: {
		sceneId: string;
		// The owning story; continuation posts it so the server can gate and scope.
		storyId: string;
		title: string | null;
		body: string;
		entities?: MentionEntity[];
		// Disambiguation context and the pin callback for shared names.
		mentionOptions?: MentionOptions;
		// When true, Ctrl/Cmd+J asks the Assistant to continue the prose at the
		// cursor (ghost-text, Tab to accept). Off unless the Assistant is live.
		assistantContinuation?: boolean;
		autocompleteMode?: AutocompleteMode;
		editingMode?: EditingMode;
		spellCheck?: 'on' | 'off';
		writingLanguage?: string;
		markers?: SceneMarker[];
		// When set, pasted and dropped images upload into this universe and
		// land as markdown.
		imageUniverseId?: string;
		// Text a search jump arrived with; the first occurrence gets selected.
		findText?: string | null;
		// Character offset an appears-in jump arrived with; the word there
		// gets selected.
		findAt?: number | null;
		// The continuous story view stitches one editor per scene: no title
		// input, no toolbar, and vertical arrows at the edges hand focus to
		// neighbours.
		compact?: boolean;
		// Inline CSS variables that style the writing surface (font, line
		// spacing, default alignment), built by the page from the writer's
		// editor-appearance preferences. Absent in the entity editors, which
		// keep the editor's own typography.
		editorStyle?: string;
		// The universe's categories; with more than one, the selection menu's
		// lore item grows a submenu to pick where the entry files.
		loreCategories?: { id: string; name: string }[];
		onCrossBoundary?: (direction: 'up' | 'down') => void;
		// Create an entity from the right-click selection menu. Resolves to an
		// error message, or null when it worked.
		onCreateEntity?: (
			type: 'character' | 'place' | 'lore_entry',
			name: string,
			categoryId?: string
		) => Promise<string | null>;
		// When set, the selection menu offers an Assistant submenu whose "Ask
		// the Assistant about this" hands the raw selected text over (the page
		// puts it into the chat composer as a reference).
		onAskAssistant?: (text: string) => void;
		// When set, the toolbar offers splitting the scene at the cursor.
		onSplitScene?: () => void;
		// The continuous view's shared toolbar acts on whichever stitched
		// editor last took focus; this reports that.
		onFocus?: () => void;
		// Editor-view controls carried on the formatting bar.
		storyView?: { active: boolean; toggleHref: string };
		// The View dropdown (Edit, Preview, Focus, Print) on the formatting bar.
		viewMenu?: ViewItem[];
		// The prose-view toggles, shared across every editor in the story. The
		// toggle callbacks are only passed where the toolbar is shown (the
		// scene editor); the stitched editors just take the values.
		nonPrintingMarks?: MarkVisibility;
		commandMarkers?: MarkVisibility;
		onToggleNonPrinting?: () => void;
		onToggleCommandMarkers?: () => void;
		onStatus: (status: SaveStatus) => void;
	} = $props();

	// Autosave fires on a pause, not on every keystroke; the revision history
	// coalesces these so a burst of saves is one timeline entry.
	const SAVE_DEBOUNCE_MS = 1500;

	// Swappable behaviour goes in compartments from day one, so mentions and
	// autocomplete can be reconfigured at runtime in later phases.
	const mentionsCompartment = new Compartment();
	const autocompleteCompartment = new Compartment();
	const markersCompartment = new Compartment();
	// The toolbar toggles flip these at runtime.
	const nonPrintingCompartment = new Compartment();
	const alignmentCompartment = new Compartment();
	// svelte-ignore state_referenced_locally
	let markerHandle: MarkerHandle = markerExtensions(markers, markSelection);

	// Bound from one of two mutually exclusive branches (compact or full),
	// hence the state wrapper.
	let editorEl = $state<HTMLDivElement>();
	// The pane's scroll container (full editor only); the page snapshot
	// reads and restores its position across history navigation.
	let scrollEl = $state<HTMLDivElement>();
	let view: EditorView | undefined;

	// Co-author: a toolbar-opened panel that drafts a passage to a brief, which
	// the writer inserts at the cursor, edits, or discards (see CoauthorPanel).
	// The open state bridges the toolbar toggle and the panel.
	let coauthorOpen = $state(false);
	function toggleCoauthor() {
		coauthorOpen = !coauthorOpen;
	}

	// The editor owns the value after mount; the page keys this component by
	// scene id, so a different scene means a fresh instance.
	// svelte-ignore state_referenced_locally
	let titleValue = $state(title ?? '');
	const autosave = createAutosave({
		debounceMs: SAVE_DEBOUNCE_MS,
		onStatus: (status) => onStatus(status),
		save: async ({ keepalive }) => {
			if (!view) return;
			const response = await fetch(`/api/scenes/${sceneId}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				keepalive,
				body: JSON.stringify({
					title: titleValue,
					bodyMd: view.state.doc.toString(),
					// Marker anchors as the editor mapped them through edits.
					markers: markerHandle.anchors(view)
				})
			});
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
		}
	});
	const scheduleSave = autosave.schedule;

	// A new marker's anchors must land against saved text, so the prose is
	// flushed first; the page data refresh then re-renders the highlights.
	async function markSelection(from: number, to: number) {
		await autosave.flush();
		const response = await fetch(`/api/scenes/${sceneId}/markers`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ anchorStart: from, anchorEnd: to })
		});
		if (response.ok) await invalidateAll();
	}

	// At the visual top or bottom of this editor, vertical arrows hand
	// focus to the neighbouring scene instead of dying at the edge. High
	// precedence, because the default keymap consumes an edge ArrowDown to
	// record its goal column and would eat the first press.
	function boundaryKeymap() {
		if (!onCrossBoundary) return [];
		const cross = (forward: boolean) => (view: EditorView) => {
			const range = view.state.selection.main;
			if (!range.empty) return false;
			const moved = view.moveVertically(range, forward);
			if (moved.head !== range.head) return false;
			onCrossBoundary!(forward ? 'down' : 'up');
			return true;
		};
		return Prec.high(
			keymap.of([
				{ key: 'ArrowDown', run: cross(true) },
				{ key: 'ArrowUp', run: cross(false) }
			])
		);
	}

	// Where the writer was, for the page's history snapshot: the browser
	// back button then returns to the same scroll position and caret
	// instead of the top of the scene.
	export function getViewPosition(): { anchor: number; scroll: number } | null {
		if (!view) return null;
		return { anchor: view.state.selection.main.head, scroll: scrollEl?.scrollTop ?? 0 };
	}

	export function restoreViewPosition(position: { anchor: number; scroll: number }) {
		if (!view) return;
		// Clamped: the text may have changed under the history entry.
		view.dispatch({ selection: { anchor: Math.min(position.anchor, view.state.doc.length) } });
		if (scrollEl) scrollEl.scrollTop = position.scroll;
	}

	// For splitting at the cursor: where the caret is, and a way to land the
	// pending autosave first so the offset is against the stored text.
	export function cursorOffset(): { offset: number; length: number } | null {
		if (!view) return null;
		return { offset: view.state.selection.main.head, length: view.state.doc.length };
	}

	export async function flushSave(): Promise<void> {
		await autosave.flush();
	}

	// Whether an edit is waiting in the debounce window. The page uses this to
	// flush before navigating away, so a quick scene round-trip never reloads
	// stale prose over a save still in flight.
	export function isDirty(): boolean {
		return autosave.isDirty();
	}

	// The continuous view's shared formatting toolbar runs its commands on
	// this view when this editor holds the caret.
	export function getView(): EditorView | undefined {
		return view;
	}

	// Inserts text at the caret, like the coauthor panel's Insert does; the
	// Assistant tab uses it to drop a chat reply into the scene.
	export function insertAtCursor(text: string) {
		if (!view || !text) return;
		const head = view.state.selection.main.head;
		view.dispatch({
			changes: { from: head, insert: text },
			selection: { anchor: head + text.length },
			scrollIntoView: true
		});
		scheduleSave();
		view.focus();
	}

	// The current selection's text, or null when nothing is selected. The
	// Assistant tab's /rewrite command reads it to rewrite the chosen passage.
	export function getSelectionText(): string | null {
		if (!view) return null;
		const { from, to } = view.state.selection.main;
		if (from === to) return null;
		return view.state.sliceDoc(from, to);
	}

	// Replaces the current selection with text, or inserts at the caret when
	// nothing is selected. The /rewrite affordance drops its rewrite in over the
	// passage it rewrote.
	export function replaceSelection(text: string) {
		if (!view || !text) return;
		const { from, to } = view.state.selection.main;
		view.dispatch({
			changes: { from, to, insert: text },
			selection: { anchor: from + text.length },
			scrollIntoView: true
		});
		scheduleSave();
		view.focus();
	}

	// Lets the page place the caret when focus crosses a scene boundary.
	export function focusEdge(edge: 'start' | 'end') {
		if (!view) return;
		view.focus();
		view.dispatch({
			selection: { anchor: edge === 'start' ? 0 : view.state.doc.length },
			scrollIntoView: true
		});
	}

	// Checking a marker off elsewhere (or creating one) changes the set of
	// ids; rebuild the highlights from the fresh server anchors. Same-set
	// updates keep the editor's own mapped positions, which are newer.
	$effect(() => {
		const incoming = markers
			.map((marker) => marker.id)
			.sort()
			.join(',');
		const current = [...markerHandle.ids].sort().join(',');
		if (!view || incoming === current) return;
		markerHandle = markerExtensions(markers, markSelection);
		view.dispatch({ effects: markersCompartment.reconfigure(markerHandle.extension) });
	});

	// The toolbar's view toggles, flipped from any editor in the story; each
	// editor reconfigures its own compartment to match. The prop is read before
	// the view guard so it is tracked even on the first (pre-mount) run.
	$effect(() => {
		const extension = nonPrintingFor(nonPrintingMarks);
		if (!view) return;
		view.dispatch({ effects: nonPrintingCompartment.reconfigure(extension) });
	});
	$effect(() => {
		const extension = commandMarkerExtensions(commandMarkers);
		if (!view) return;
		view.dispatch({ effects: alignmentCompartment.reconfigure(extension) });
	});

	// A search jump selects the first occurrence of the text it arrived
	// with, so the match is visible rather than somewhere off-screen.
	function applyFind() {
		if (!findText || !view) return;
		const at = view.state.doc.toString().toLowerCase().indexOf(findText.toLowerCase());
		if (at < 0) return;
		view.dispatch({
			selection: { anchor: at, head: at + findText.length },
			scrollIntoView: true
		});
		view.focus();
	}

	// An appears-in jump lands on a mention's offset; select the word there.
	// Clamped, because the text may have moved since the index was built.
	function applyFindAt() {
		if (findAt === null || !view) return;
		const at = Math.min(findAt, view.state.doc.length);
		const word = view.state.wordAt(at);
		view.dispatch({
			selection: word ? { anchor: word.from, head: word.to } : { anchor: at },
			scrollIntoView: true
		});
		view.focus();
	}

	// Reapply when the jump target changes on an already-open scene. On a
	// fresh mount these run before onMount has created the view, so they bail
	// here and the selection is applied from onMount instead (view is a plain
	// variable, not reactive, so assigning it does not re-run an effect).
	$effect(() => {
		applyFind();
	});
	$effect(() => {
		applyFindAt();
	});

	// Pinning a shared name or creating an entity changes the underlines at
	// once: the page data refresh delivers new pins or entities, and the
	// mentions compartment reloads.
	function mentionFingerprint() {
		return JSON.stringify([
			mentionOptions.pins ?? {},
			entities.map((entity) => [entity.id, entity.name, entity.aliases])
		]);
	}
	let appliedMentions = mentionFingerprint();
	$effect(() => {
		const incoming = mentionFingerprint();
		if (!view || incoming === appliedMentions) return;
		appliedMentions = incoming;
		view.dispatch({
			effects: mentionsCompartment.reconfigure(mentionExtensions(entities, mentionOptions))
		});
	});

	// The right-click selection menu: quick formatting plus create-from-
	// selection. Only an actual selection hijacks the native menu, so the
	// browser's spelling suggestions stay reachable on a plain caret click.
	// The handler sits on the pane wrapper rather than the prose column, so
	// the margins around the centered text behave like the text itself.
	let selectionMenu = $state<{ x: number; y: number; name: string; raw: string } | null>(null);

	function onPaneContextMenu(event: MouseEvent) {
		if (view) openSelectionMenu(event, view);
	}

	function openSelectionMenu(event: MouseEvent, editor: EditorView): boolean {
		const range = editor.state.selection.main;
		if (range.empty) return false;
		const raw = editor.state.sliceDoc(range.from, range.to);
		const name = raw.replace(/\s+/g, ' ').trim();
		if (!name) return false;
		event.preventDefault();
		selectionMenu = {
			x: Math.min(event.clientX, window.innerWidth - 240),
			y: Math.min(event.clientY, window.innerHeight - 230),
			name,
			raw
		};
		return true;
	}

	function closeSelectionMenu() {
		selectionMenu = null;
	}

	// Leaving the title field commits the rename at once instead of waiting
	// out the debounce, so a rename right before a reload is already saved.
	const flushTitle = autosave.flushSoon;

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: body,
				extensions: [
					...proseExtensions({
						placeholder: 'Start writing...',
						onDocChanged: scheduleSave,
						editingMode,
						spellCheck: { enabled: spellCheck === 'on', language: writingLanguage },
						nonPrintingMarks,
						commandMarkers,
						compartments: {
							nonPrinting: nonPrintingCompartment,
							alignment: alignmentCompartment
						}
					}),
					mentionsCompartment.of(mentionExtensions(entities, mentionOptions)),
					autocompleteCompartment.of(autocompleteExtensions(entities, autocompleteMode)),
					markersCompartment.of(markerHandle.extension),
					assistantContinuation && storyId ? continuationExtensions(storyId) : [],
					boundaryKeymap(),
					onFocus
						? EditorView.updateListener.of((update) => {
								if (update.focusChanged && update.view.hasFocus) onFocus();
							})
						: [],
					imageUniverseId ? imageUploadExtension(imageUniverseId) : []
				]
			})
		});
		// Apply any jump the scene mounted with: the find effects already ran
		// (and bailed) before the view existed, and will not re-run on their own.
		applyFind();
		applyFindAt();
		return () => {
			// Last-chance flush so navigating away does not lose the tail edit.
			void autosave.teardown().then(() => {
				view?.destroy();
				view = undefined;
			});
		};
	});
</script>

{#if compact}
	<div
		class="editor compact"
		role="presentation"
		style={editorStyle}
		oncontextmenu={onPaneContextMenu}
	>
		<div class="editor-cm" bind:this={editorEl}></div>
	</div>
{:else}
	<!-- The prototype's editor frame: a full-width toolbar pinned to the
	     pane top, with the centered prose column scrolling underneath. -->
	<div class="md-editor">
		<EditorToolbar
			view={() => view}
			{onSplitScene}
			{storyView}
			{viewMenu}
			nonPrintingActive={nonPrintingMarks === 'shown'}
			{onToggleNonPrinting}
			commandMarkersActive={commandMarkers === 'shown'}
			{onToggleCommandMarkers}
			onCoauthor={assistantContinuation && storyId ? toggleCoauthor : undefined}
			coauthorActive={coauthorOpen}
		/>
		{#if coauthorOpen}
			<CoauthorPanel
				getView={() => view}
				{storyId}
				{sceneId}
				onInserted={scheduleSave}
				onClose={() => (coauthorOpen = false)}
			/>
		{/if}
		<div
			class="editor-scroll"
			role="presentation"
			bind:this={scrollEl}
			oncontextmenu={onPaneContextMenu}
		>
			<div class="editor" style={editorStyle}>
				<input
					class="editor-title-input"
					type="text"
					placeholder="Untitled scene"
					bind:value={titleValue}
					oninput={scheduleSave}
					onchange={flushTitle}
				/>
				<div class="editor-cm" bind:this={editorEl}></div>
			</div>
		</div>
	</div>
{/if}

<svelte:window onpagehide={autosave.flushOnPageHide} />

{#if selectionMenu}
	<SelectionMenu
		menu={selectionMenu}
		getView={() => view}
		{onCreateEntity}
		{onAskAssistant}
		{loreCategories}
		onClose={closeSelectionMenu}
	/>
{/if}

<style>
	.editor-title-input {
		width: 100%;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-content);
		font-size: 32px;
		font-weight: 600;
		letter-spacing: -0.015em;
		padding: 0 0 14px;
		outline: none;
	}
	.editor-title-input::placeholder {
		color: var(--text-faint);
	}
	.editor.compact :global(.editor-cm) {
		min-height: 0;
	}
</style>
