<script lang="ts" module>
	export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { EditorView, keymap } from '@codemirror/view';
	import { Compartment, EditorState, Prec } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';
	import { mentionExtensions, type MentionEntity } from '$lib/editor-mentions';
	import { autocompleteExtensions, type AutocompleteMode } from '$lib/editor-autocomplete';
	import { markerExtensions, type MarkerHandle, type SceneMarker } from '$lib/editor-markers';

	let {
		sceneId,
		title,
		body,
		entities = [],
		autocompleteMode = 'popup',
		markers = [],
		compact = false,
		onCrossBoundary,
		onStatus
	}: {
		sceneId: string;
		title: string | null;
		body: string;
		entities?: MentionEntity[];
		autocompleteMode?: AutocompleteMode;
		markers?: SceneMarker[];
		// The continuous story view stitches one editor per scene: no title
		// input, and vertical arrows at the edges hand focus to neighbours.
		compact?: boolean;
		onCrossBoundary?: (direction: 'up' | 'down') => void;
		onStatus: (status: SaveStatus) => void;
	} = $props();

	const SAVE_DEBOUNCE_MS = 800;

	// Swappable behaviour goes in compartments from day one, so mentions and
	// autocomplete can be reconfigured at runtime in later phases.
	const mentionsCompartment = new Compartment();
	const autocompleteCompartment = new Compartment();
	const markersCompartment = new Compartment();
	// svelte-ignore state_referenced_locally
	let markerHandle: MarkerHandle = markerExtensions(markers, markSelection);

	let editorEl: HTMLDivElement;
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

	function scheduleSave() {
		dirty = true;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(enqueueSave, SAVE_DEBOUNCE_MS);
	}

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: body,
				extensions: [
					...proseExtensions({ placeholder: 'Start writing...', onDocChanged: scheduleSave }),
					mentionsCompartment.of(mentionExtensions(entities)),
					autocompleteCompartment.of(autocompleteExtensions(entities, autocompleteMode)),
					markersCompartment.of(markerHandle.extension),
					boundaryKeymap()
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

<div class="editor" class:compact>
	{#if !compact}
		<input
			class="editor-title-input"
			type="text"
			placeholder="Untitled scene"
			bind:value={titleValue}
			oninput={scheduleSave}
		/>
	{/if}
	<div class="editor-cm" bind:this={editorEl}></div>
</div>

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
