<script lang="ts" module>
	export type EntityKind = 'character' | 'place' | 'lore';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';
	import { entityColor, entityLetter } from '$lib/entity-color';
	import type { SaveStatus } from './SceneEditor.svelte';

	let {
		kind,
		entity,
		categories = [],
		storyId,
		storyNotesMd,
		onStatus
	}: {
		kind: EntityKind;
		entity: {
			id: string;
			name: string;
			aliases?: string[];
			keywords?: string[];
			categoryId?: string | null;
			summaryMd: string | null;
			bodyMd: string;
		};
		categories?: { id: string; name: string; color: string | null }[];
		// Absent at universe scope; the "In this book" notes need a story.
		storyId?: string;
		storyNotesMd?: string;
		onStatus: (status: SaveStatus) => void;
	} = $props();

	const SAVE_DEBOUNCE_MS = 800;
	// kind never changes for an instance; the page keys this component by
	// entity id.
	// svelte-ignore state_referenced_locally
	const ENDPOINT = kind === 'character' ? 'characters' : kind === 'place' ? 'places' : 'lore';
	// svelte-ignore state_referenced_locally
	const BODY_PLACEHOLDER =
		kind === 'character'
			? 'Who are they? History, voice, appearance, secrets...'
			: kind === 'place'
				? 'What is this place? Geography, mood, who holds it...'
				: 'What is it? Rules, history, how it matters...';

	let editorEl: HTMLDivElement;
	let view: EditorView | undefined;
	// The editor owns the values after mount; the page keys this component by
	// entity id, so a different entity means a fresh instance.
	// svelte-ignore state_referenced_locally
	let name = $state(entity.name);
	// svelte-ignore state_referenced_locally
	let aliasesText = $state((entity.aliases ?? []).join(', '));
	// svelte-ignore state_referenced_locally
	let keywordsText = $state((entity.keywords ?? []).join(', '));
	// svelte-ignore state_referenced_locally
	let categoryValue = $state(entity.categoryId ?? '');
	// svelte-ignore state_referenced_locally
	let summary = $state(entity.summaryMd ?? '');
	// svelte-ignore state_referenced_locally
	let notes = $state(storyNotesMd ?? '');
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
			const payload: Record<string, unknown> = {
				name,
				summaryMd: summary,
				bodyMd: view.state.doc.toString()
			};
			if (storyId) {
				payload.storyId = storyId;
				payload.storyNotesMd = notes;
			}
			if (kind === 'character') {
				payload.aliases = aliasesText.split(',').map((alias) => alias.trim());
			}
			if (kind === 'lore') {
				payload.keywords = keywordsText.split(',').map((keyword) => keyword.trim());
			}
			if (categories.length > 0) {
				payload.categoryId = categoryValue || null;
			}
			const response = await fetch(`/api/${ENDPOINT}/${entity.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
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
				doc: entity.bodyMd,
				extensions: proseExtensions({
					placeholder: BODY_PLACEHOLDER,
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
		<span
			class="badge lg"
			style="background: {categories.find((c) => c.id === categoryValue)?.color ??
				entityColor(entity.name)}"
		>
			{entityLetter(entity.name)}
		</span>
		<input
			class="detail-title-input"
			type="text"
			placeholder="Name"
			bind:value={name}
			oninput={scheduleSave}
		/>
	</div>

	{#if kind === 'character'}
		<div class="section-label">Aliases</div>
		<input
			class="line-input"
			type="text"
			placeholder="Nicknames and variants, separated by commas. Used to spot mentions."
			bind:value={aliasesText}
			oninput={scheduleSave}
		/>
	{/if}

	{#if kind === 'lore'}
		<div class="section-label">Keywords</div>
		<input
			class="line-input"
			type="text"
			placeholder="Terms that refer to this entry, separated by commas. Used to spot mentions."
			bind:value={keywordsText}
			oninput={scheduleSave}
		/>
	{/if}

	{#if categories.length > 0}
		<div class="section-label">Category</div>
		<select class="line-input" bind:value={categoryValue} onchange={scheduleSave}>
			{#if kind !== 'lore'}
				<option value="">No category</option>
			{/if}
			{#each categories as category (category.id)}
				<option value={category.id}>{category.name}</option>
			{/each}
		</select>
	{/if}

	<div class="section-label">Summary</div>
	<textarea
		class="area-input"
		rows="2"
		placeholder="One or two lines. Shown when a mention is hovered."
		bind:value={summary}
		oninput={scheduleSave}
	></textarea>

	<div class="section-label">Description</div>
	<div class="editor-cm" bind:this={editorEl}></div>

	{#if storyId}
		<div class="section-label">In this book</div>
		<textarea
			class="area-input"
			rows="3"
			placeholder="Notes that apply only to this story."
			bind:value={notes}
			oninput={scheduleSave}
		></textarea>
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
	.line-input,
	.area-input {
		width: 100%;
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		color: var(--text);
		font-size: 13.5px;
		line-height: 1.55;
		padding: 8px 10px;
		outline: none;
		resize: vertical;
	}
	.line-input:focus,
	.area-input:focus {
		border-color: var(--accent-line);
	}
	.line-input::placeholder,
	.area-input::placeholder {
		color: var(--text-faint);
	}
	.editor-cm {
		min-height: 180px;
		padding: 4px 0 12px;
	}
</style>
