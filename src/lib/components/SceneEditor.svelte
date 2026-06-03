<script lang="ts" module>
	export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView } from '@codemirror/view';
	import { Compartment, EditorState } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';

	let {
		sceneId,
		title,
		body,
		onStatus
	}: {
		sceneId: string;
		title: string | null;
		body: string;
		onStatus: (status: SaveStatus) => void;
	} = $props();

	const SAVE_DEBOUNCE_MS = 800;

	// Swappable behaviour goes in compartments from day one, so mentions and
	// autocomplete can be reconfigured at runtime in later phases.
	const mentionsCompartment = new Compartment();
	const autocompleteCompartment = new Compartment();

	let editorEl: HTMLDivElement;
	let view: EditorView | undefined;
	// The editor owns the value after mount; the page keys this component by
	// scene id, so a different scene means a fresh instance.
	// svelte-ignore state_referenced_locally
	let titleValue = $state(title ?? '');
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;

	async function save() {
		if (!view) return;
		dirty = false;
		onStatus('saving');
		try {
			const response = await fetch(`/api/scenes/${sceneId}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: titleValue, bodyMd: view.state.doc.toString() })
			});
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
			onStatus(dirty ? 'saving' : 'saved');
		} catch {
			dirty = true;
			onStatus('error');
		}
	}

	function scheduleSave() {
		dirty = true;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
	}

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: body,
				extensions: [
					...proseExtensions({ placeholder: 'Start writing...', onDocChanged: scheduleSave }),
					mentionsCompartment.of([]),
					autocompleteCompartment.of([])
				]
			})
		});
		return () => {
			clearTimeout(saveTimer);
			// Last-chance flush so navigating away does not lose the tail edit.
			if (dirty) void save();
			view?.destroy();
			view = undefined;
		};
	});
</script>

<div class="editor">
	<input
		class="editor-title-input"
		type="text"
		placeholder="Untitled scene"
		bind:value={titleValue}
		oninput={scheduleSave}
	/>
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
</style>
