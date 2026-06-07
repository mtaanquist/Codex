<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';
	import type { SaveStatus } from './SceneEditor.svelte';

	let {
		note,
		onStatus
	}: {
		note: { id: string; title: string | null; bodyMd: string };
		onStatus: (status: SaveStatus) => void;
	} = $props();

	const SAVE_DEBOUNCE_MS = 800;

	let editorEl: HTMLDivElement;
	let view: EditorView | undefined;
	// The editor owns the values after mount; the page keys this component by
	// note id, so a different note means a fresh instance.
	// svelte-ignore state_referenced_locally
	let title = $state(note.title ?? '');
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	// Saves are chained so an earlier slow request can never overwrite a newer one.
	let saveChain: Promise<void> = Promise.resolve();

	async function save() {
		if (!view) return;
		dirty = false;
		onStatus('saving');
		try {
			const response = await fetch(`/api/notes/${note.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title, bodyMd: view.state.doc.toString() })
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

	function scheduleSave() {
		dirty = true;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(enqueueSave, SAVE_DEBOUNCE_MS);
	}

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: note.bodyMd,
				extensions: proseExtensions({
					placeholder: 'Jot anything: ideas, threads to pull, things to remember...',
					onDocChanged: scheduleSave
				})
			})
		});
		return () => {
			clearTimeout(saveTimer);
			if (dirty) enqueueSave();
			void saveChain.then(() => {
				view?.destroy();
				view = undefined;
			});
		};
	});
</script>

<div class="detail">
	<div class="detail-head">
		<input
			class="detail-title-input"
			type="text"
			placeholder="Untitled note"
			bind:value={title}
			oninput={scheduleSave}
		/>
	</div>
	<div class="editor-cm" bind:this={editorEl}></div>
</div>

<style>
	.detail-title-input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: none;
		color: var(--text);
		font-size: 24px;
		font-weight: 650;
		letter-spacing: -0.015em;
		outline: none;
	}
	.detail-title-input::placeholder {
		color: var(--text-faint);
	}
	.editor-cm {
		min-height: 320px;
		padding: 4px 0 12px;
	}
</style>
