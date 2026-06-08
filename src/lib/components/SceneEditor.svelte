<script lang="ts" module>
	export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { EditorView, keymap } from '@codemirror/view';
	import { Compartment, EditorState, Prec } from '@codemirror/state';
	import { proseExtensions, type EditingMode } from '$lib/editor';
	import { toggleBold, toggleBulletList, toggleItalic, toggleQuote } from '$lib/editor-format';
	import { mentionExtensions, type MentionEntity, type MentionOptions } from '$lib/editor-mentions';
	import { autocompleteExtensions, type AutocompleteMode } from '$lib/editor-autocomplete';
	import { imageUploadExtension } from '$lib/editor-images';
	import { markerExtensions, type MarkerHandle, type SceneMarker } from '$lib/editor-markers';
	import EditorToolbar from './EditorToolbar.svelte';
	import Icon from './Icon.svelte';

	let {
		sceneId,
		title,
		body,
		entities = [],
		mentionOptions = {},
		autocompleteMode = 'popup',
		editingMode = 'markdown',
		spellCheck = 'off',
		writingLanguage = '',
		markers = [],
		imageUniverseId,
		findText = null,
		findAt = null,
		compact = false,
		loreCategories = [],
		onCrossBoundary,
		onCreateEntity,
		onSplitScene,
		onFocus,
		storyView,
		previewHref,
		onEnterFocus,
		onStatus
	}: {
		sceneId: string;
		title: string | null;
		body: string;
		entities?: MentionEntity[];
		// Disambiguation context and the pin callback for shared names.
		mentionOptions?: MentionOptions;
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
		// When set, the toolbar offers splitting the scene at the cursor.
		onSplitScene?: () => void;
		// The continuous view's shared toolbar acts on whichever stitched
		// editor last took focus; this reports that.
		onFocus?: () => void;
		// Editor-view controls carried on the formatting bar.
		storyView?: { active: boolean; toggleHref: string };
		// When set, a Preview button on the bar opens the read-only export view.
		previewHref?: string;
		onEnterFocus?: () => void;
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
	// svelte-ignore state_referenced_locally
	let markerHandle: MarkerHandle = markerExtensions(markers, markSelection);

	// Bound from one of two mutually exclusive branches (compact or full),
	// hence the state wrapper.
	let editorEl = $state<HTMLDivElement>();
	// The pane's scroll container (full editor only); the page snapshot
	// reads and restores its position across history navigation.
	let scrollEl = $state<HTMLDivElement>();
	let view: EditorView | undefined;
	// The editor owns the value after mount; the page keys this component by
	// scene id, so a different scene means a fresh instance.
	// svelte-ignore state_referenced_locally
	let titleValue = $state(title ?? '');
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	// Saves are chained so an earlier slow request can never land after, and
	// overwrite, a newer one.
	let saveChain: Promise<void> = Promise.resolve();

	async function save() {
		if (!view) return;
		dirty = false;
		onStatus('saving');
		try {
			const response = await fetch(`/api/scenes/${sceneId}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: titleValue,
					bodyMd: view.state.doc.toString(),
					// Marker anchors as the editor mapped them through edits.
					markers: markerHandle.anchors(view)
				})
			});
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
			onStatus(dirty ? 'saving' : 'saved');
		} catch {
			dirty = true;
			onStatus('error');
		}
	}

	function enqueueSave() {
		saveChain = saveChain.then(save);
	}

	// A new marker's anchors must land against saved text, so the prose is
	// flushed first; the page data refresh then re-renders the highlights.
	async function markSelection(from: number, to: number) {
		clearTimeout(saveTimer);
		enqueueSave();
		await saveChain;
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
		clearTimeout(saveTimer);
		if (dirty) enqueueSave();
		await saveChain;
	}

	// The continuous view's shared formatting toolbar runs its commands on
	// this view when this editor holds the caret.
	export function getView(): EditorView | undefined {
		return view;
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

	// A search jump selects the first occurrence of the text it arrived
	// with, so the match is visible rather than somewhere off-screen.
	$effect(() => {
		if (!findText || !view) return;
		const at = view.state.doc.toString().toLowerCase().indexOf(findText.toLowerCase());
		if (at < 0) return;
		view.dispatch({
			selection: { anchor: at, head: at + findText.length },
			scrollIntoView: true
		});
		view.focus();
	});

	// An appears-in jump lands on a mention's offset; select the word there.
	// Clamped, because the text may have moved since the index was built.
	$effect(() => {
		if (findAt === null || !view) return;
		const at = Math.min(findAt, view.state.doc.length);
		const word = view.state.wordAt(at);
		view.dispatch({
			selection: word ? { anchor: word.from, head: word.to } : { anchor: at },
			scrollIntoView: true
		});
		view.focus();
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
	let selectionMenu = $state<{ x: number; y: number; name: string } | null>(null);
	let menuBusy = $state(false);
	let menuError = $state('');

	function onPaneContextMenu(event: MouseEvent) {
		if (view) openSelectionMenu(event, view);
	}

	// The lore item's category flyout; reset whenever the menu opens.
	let loreSubOpen = $state(false);

	function openSelectionMenu(event: MouseEvent, editor: EditorView): boolean {
		const range = editor.state.selection.main;
		if (range.empty) return false;
		const name = editor.state.sliceDoc(range.from, range.to).replace(/\s+/g, ' ').trim();
		if (!name) return false;
		event.preventDefault();
		menuError = '';
		menuBusy = false;
		loreSubOpen = false;
		selectionMenu = {
			x: Math.min(event.clientX, window.innerWidth - 240),
			y: Math.min(event.clientY, window.innerHeight - 230),
			name
		};
		return true;
	}

	function closeSelectionMenu() {
		selectionMenu = null;
	}

	function runFormat(command: (view: EditorView) => boolean) {
		if (view) command(view);
		closeSelectionMenu();
		view?.focus();
	}

	async function createFromSelection(
		type: 'character' | 'place' | 'lore_entry',
		categoryId?: string
	) {
		if (!onCreateEntity || !selectionMenu || menuBusy) return;
		menuBusy = true;
		menuError = '';
		try {
			const failure = await onCreateEntity(type, selectionMenu.name, categoryId);
			if (failure) {
				menuError = failure;
				menuBusy = false;
			} else {
				closeSelectionMenu();
			}
		} catch {
			menuError = 'Could not create it. Try again.';
			menuBusy = false;
		}
	}

	function onWindowPointerDown(event: MouseEvent) {
		if (!selectionMenu) return;
		const target = event.target as HTMLElement | null;
		if (!target?.closest('.sel-menu')) closeSelectionMenu();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && selectionMenu) {
			event.preventDefault();
			closeSelectionMenu();
			view?.focus();
		}
	}

	function scheduleSave() {
		dirty = true;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(enqueueSave, SAVE_DEBOUNCE_MS);
	}

	// Leaving the title field commits the rename at once instead of waiting
	// out the debounce, so a rename right before a reload is already saved.
	function flushTitle() {
		if (!dirty) return;
		clearTimeout(saveTimer);
		enqueueSave();
	}

	// A reload or tab close inside the debounce window would silently drop
	// the last edit: component teardown does not run on browser unload, so
	// the pending save is flushed here with a request that outlives the
	// page. Bodies past the keepalive cap reject, which the debounced saves
	// already covered up to the last pause.
	function flushOnPageHide() {
		if (!dirty || !view) return;
		clearTimeout(saveTimer);
		dirty = false;
		void fetch(`/api/scenes/${sceneId}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			keepalive: true,
			body: JSON.stringify({
				title: titleValue,
				bodyMd: view.state.doc.toString(),
				markers: markerHandle.anchors(view)
			})
		}).catch(() => {
			dirty = true;
		});
	}

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
						spellCheck: { enabled: spellCheck === 'on', language: writingLanguage }
					}),
					mentionsCompartment.of(mentionExtensions(entities, mentionOptions)),
					autocompleteCompartment.of(autocompleteExtensions(entities, autocompleteMode)),
					markersCompartment.of(markerHandle.extension),
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
		return () => {
			clearTimeout(saveTimer);
			// Last-chance flush so navigating away does not lose the tail edit.
			if (dirty) enqueueSave();
			void saveChain.then(() => {
				view?.destroy();
				view = undefined;
			});
		};
	});
</script>

{#if compact}
	<div class="editor compact" role="presentation" oncontextmenu={onPaneContextMenu}>
		<div class="editor-cm" bind:this={editorEl}></div>
	</div>
{:else}
	<!-- The prototype's editor frame: a full-width toolbar pinned to the
	     pane top, with the centered prose column scrolling underneath. -->
	<div class="md-editor">
		<EditorToolbar
			view={() => view}
			modeLabel={editingMode === 'rich' ? 'Rich text' : 'Markdown'}
			{onSplitScene}
			{storyView}
			{previewHref}
			{onEnterFocus}
		/>
		<div
			class="editor-scroll"
			role="presentation"
			bind:this={scrollEl}
			oncontextmenu={onPaneContextMenu}
		>
			<div class="editor">
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

<svelte:window
	onmousedown={onWindowPointerDown}
	onkeydown={onWindowKeydown}
	onpagehide={flushOnPageHide}
/>

{#if selectionMenu}
	<div class="sel-menu" role="menu" style="left: {selectionMenu.x}px; top: {selectionMenu.y}px;">
		<div class="sel-menu-formats">
			<button
				class="sel-format"
				type="button"
				role="menuitem"
				title="Bold (Ctrl+B)"
				onclick={() => runFormat(toggleBold)}
			>
				<Icon name="bold" size={15} />
			</button>
			<button
				class="sel-format"
				type="button"
				role="menuitem"
				title="Italic (Ctrl+I)"
				onclick={() => runFormat(toggleItalic)}
			>
				<Icon name="italic" size={15} />
			</button>
			<button
				class="sel-format"
				type="button"
				role="menuitem"
				title="Quote"
				onclick={() => runFormat(toggleQuote)}
			>
				<Icon name="quote" size={15} />
			</button>
			<button
				class="sel-format"
				type="button"
				role="menuitem"
				title="Bullet list"
				onclick={() => runFormat(toggleBulletList)}
			>
				<Icon name="list" size={15} />
			</button>
		</div>
		{#if onCreateEntity}
			<div class="sel-menu-label">
				"{selectionMenu.name.length > 32
					? `${selectionMenu.name.slice(0, 32)}...`
					: selectionMenu.name}"
			</div>
			<button
				class="sel-create"
				type="button"
				role="menuitem"
				disabled={menuBusy}
				onclick={() => createFromSelection('character')}
			>
				New character
			</button>
			<button
				class="sel-create"
				type="button"
				role="menuitem"
				disabled={menuBusy}
				onclick={() => createFromSelection('place')}
			>
				New place
			</button>
			{#if loreCategories.length > 1}
				<!-- More than one category: the lore item opens a flyout to pick
				     which one the new entry files under. -->
				<div
					class="sel-sub"
					role="presentation"
					onmouseenter={() => (loreSubOpen = true)}
					onmouseleave={() => (loreSubOpen = false)}
				>
					<button
						class="sel-create sel-sub-trigger"
						type="button"
						role="menuitem"
						aria-haspopup="menu"
						aria-expanded={loreSubOpen}
						disabled={menuBusy}
						onclick={() => (loreSubOpen = !loreSubOpen)}
					>
						New lore entry
						<Icon name="chevron" size={12} />
					</button>
					{#if loreSubOpen}
						<div class="sel-submenu" role="menu">
							{#each loreCategories as category (category.id)}
								<button
									class="sel-create"
									type="button"
									role="menuitem"
									disabled={menuBusy}
									onclick={() => createFromSelection('lore_entry', category.id)}
								>
									{category.name}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<button
					class="sel-create"
					type="button"
					role="menuitem"
					disabled={menuBusy}
					onclick={() => createFromSelection('lore_entry')}
				>
					New lore entry
				</button>
			{/if}
			{#if menuError}
				<p class="sel-menu-error" role="alert">{menuError}</p>
			{/if}
		{/if}
	</div>
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

	/* The right-click selection menu. */
	.sel-menu {
		position: fixed;
		z-index: 60;
		min-width: 190px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
	}
	.sel-menu-formats {
		display: flex;
		gap: 2px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--border);
		margin-bottom: 4px;
	}
	.sel-format {
		border: 0;
		background: none;
		color: var(--text-muted);
		border-radius: 5px;
		padding: 5px 7px;
		/* Native context menus keep the arrow cursor; match them. */
		cursor: default;
		display: inline-flex;
	}
	.sel-format:hover {
		background: var(--accent-soft);
		color: var(--text);
	}
	.sel-menu-label {
		font-family: var(--font-ui);
		font-size: 10.5px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		padding: 4px 7px 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 220px;
	}
	.sel-create {
		display: block;
		width: 100%;
		text-align: left;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		padding: 6px 7px;
		border-radius: 5px;
		cursor: default;
	}
	.sel-create:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	.sel-create:disabled {
		color: var(--text-faint);
	}
	.sel-menu-error {
		font-family: var(--font-ui);
		font-size: 12px;
		color: var(--danger, #c0564f);
		margin: 2px 7px 4px;
	}
	/* The lore item's category flyout. */
	.sel-sub {
		position: relative;
	}
	.sel-sub-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.sel-submenu {
		position: absolute;
		left: calc(100% - 2px);
		top: -7px;
		min-width: 150px;
		max-height: 260px;
		overflow-y: auto;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
		z-index: 61;
	}
</style>
