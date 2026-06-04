<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { resolve } from '$app/paths';
	import { proseExtensions } from '$lib/editor';
	import type { SaveStatus } from './SceneEditor.svelte';

	let {
		node,
		storyId,
		chapters = [],
		scenes = [],
		onStatus,
		onDeleted
	}: {
		node: {
			id: string;
			title: string;
			bodyMd: string;
			linkedSceneId: string | null;
			linkedChapterId: string | null;
		};
		storyId: string;
		chapters?: { id: string; title: string | null }[];
		scenes?: { id: string; title: string | null }[];
		onStatus: (status: SaveStatus) => void;
		onDeleted: () => void;
	} = $props();

	const SAVE_DEBOUNCE_MS = 800;

	let editorEl: HTMLDivElement;
	let view: EditorView | undefined;
	// The editor owns the values after mount; the page keys this component by
	// node id, so a different node means a fresh instance.
	// svelte-ignore state_referenced_locally
	let title = $state(node.title);
	// The link select stores one value for either kind of link.
	// svelte-ignore state_referenced_locally
	let link = $state(
		node.linkedSceneId
			? `scene:${node.linkedSceneId}`
			: node.linkedChapterId
				? `chapter:${node.linkedChapterId}`
				: ''
	);
	const linkedSceneId = $derived(link.startsWith('scene:') ? link.slice(6) : null);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	// Mirrors what we report to the top bar, for the inline Save control.
	let status = $state<SaveStatus>('idle');
	function report(next: SaveStatus) {
		status = next;
		onStatus(next);
	}
	// Saves are chained so an earlier slow request can never land after, and
	// overwrite, a newer one.
	let saveChain: Promise<void> = Promise.resolve();

	async function save() {
		if (!view) return;
		dirty = false;
		report('saving');
		try {
			const response = await fetch(`/api/outline/${node.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title,
					bodyMd: view.state.doc.toString(),
					linkedSceneId,
					linkedChapterId: link.startsWith('chapter:') ? link.slice(8) : null
				})
			});
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
			report(dirty ? 'saving' : 'saved');
		} catch {
			dirty = true;
			report('error');
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

	// Explicit save: skip the debounce and persist now.
	function saveNow() {
		clearTimeout(saveTimer);
		enqueueSave();
	}

	async function remove() {
		const response = await fetch(`/api/outline/${node.id}`, { method: 'DELETE' });
		if (response.ok) onDeleted();
	}

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: node.bodyMd,
				extensions: proseExtensions({
					placeholder: 'What happens here? Beats, intent, what must land...',
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
			placeholder="Outline node"
			bind:value={title}
			oninput={scheduleSave}
		/>
		<div class="save-control">
			<span class="save-state" class:err={status === 'error'}>
				{#if status === 'saving'}Saving...{:else if status === 'saved'}Saved{:else if status === 'error'}Not
					saved{:else}Autosaves{/if}
			</span>
			<button class="save-now" type="button" onclick={saveNow} disabled={status === 'saving'}>
				Save
			</button>
		</div>
		<button class="node-remove" type="button" onclick={remove}>Delete</button>
	</div>

	<div class="section-label">Notes</div>
	<div class="editor-cm" bind:this={editorEl}></div>

	<div class="section-label">Linked to</div>
	<select class="line-input" bind:value={link} onchange={scheduleSave} aria-label="Linked to">
		<option value="">Nothing yet</option>
		{#if chapters.length > 0}
			<optgroup label="Chapters">
				{#each chapters as chapter (chapter.id)}
					<option value={`chapter:${chapter.id}`}>{chapter.title ?? 'Untitled chapter'}</option>
				{/each}
			</optgroup>
		{/if}
		{#if scenes.length > 0}
			<optgroup label="Scenes">
				{#each scenes as scene (scene.id)}
					<option value={`scene:${scene.id}`}>{scene.title ?? 'Untitled scene'}</option>
				{/each}
			</optgroup>
		{/if}
	</select>
	{#if linkedSceneId}
		<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
		<a
			class="open-link"
			href={`${resolve('/stories/[id]', { id: storyId })}?scene=${linkedSceneId}`}
		>
			Open the linked scene
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}
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
	.save-control {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: none;
	}
	.save-state {
		font-size: 12px;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.save-state.err {
		color: var(--danger, #b00020);
	}
	.save-now {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		background: none;
		color: var(--text-muted);
		font-size: 12.5px;
		padding: 5px 12px;
		cursor: pointer;
	}
	.save-now:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--accent-line);
	}
	.save-now:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.node-remove {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		background: none;
		color: var(--text-muted);
		font-size: 12.5px;
		padding: 5px 10px;
		cursor: pointer;
	}
	.node-remove:hover {
		color: var(--danger, #b00020);
		border-color: var(--danger, #b00020);
	}
	.line-input {
		width: 100%;
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		color: var(--text);
		font-size: 13.5px;
		padding: 8px 10px;
		outline: none;
	}
	.line-input:focus {
		border-color: var(--accent-line);
	}
	.editor-cm {
		min-height: 180px;
		padding: 4px 0 12px;
	}
	.open-link {
		display: inline-block;
		margin-top: 8px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
</style>
