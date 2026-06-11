<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';
	import { createAutosave, type SaveStatus } from '$lib/autosave';

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
	const autosave = createAutosave({
		debounceMs: SAVE_DEBOUNCE_MS,
		onStatus: (status) => onStatus(status),
		save: async ({ keepalive }) => {
			if (!view) return;
			const response = await fetch(`/api/notes/${note.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				keepalive,
				body: JSON.stringify({ title, bodyMd: view.state.doc.toString() })
			});
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
		}
	});
	const scheduleSave = autosave.schedule;

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
			// Last-chance flush so navigating away does not lose the tail edit.
			void autosave.teardown().then(() => {
				view?.destroy();
				view = undefined;
			});
		};
	});
</script>

<svelte:window onpagehide={autosave.flushOnPageHide} />

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
