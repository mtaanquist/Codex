<script lang="ts" module>
	export type EntityKind = 'character' | 'place' | 'lore';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { EditorView } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';
	import { entityColor, entityLetter } from '$lib/entity-color';
	import type { SaveStatus } from './SceneEditor.svelte';

	type RelationTypeOption = {
		id: string;
		forwardLabel: string;
		fromType: string;
		toType: string;
		category: string | null;
	};
	type RelationshipRow = {
		id: string;
		label: string;
		otherId: string;
		otherName: string;
		notesMd: string | null;
	};

	let {
		kind,
		entity,
		categories = [],
		relationTypes = [],
		relationships = [],
		targets = {},
		storyId,
		storyNotesMd,
		membership = null,
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
		relationTypes?: RelationTypeOption[];
		relationships?: RelationshipRow[];
		// Entities a relationship can point at, keyed by entity type.
		targets?: Record<string, { id: string; name: string }[]>;
		// Absent at universe scope; the "In this book" notes need a story.
		storyId?: string;
		storyNotesMd?: string;
		// The entity's standing in the story; characters and places only.
		membership?: { member: boolean; mentioned: boolean } | null;
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
	// Mirrors what we report to the top bar, so the inline Save control can show
	// it right here too.
	let status = $state<SaveStatus>('idle');
	function report(next: SaveStatus) {
		status = next;
		onStatus(next);
	}
	// Saves are chained so an earlier slow request can never land after, and
	// overwrite, a newer one.
	let saveChain: Promise<void> = Promise.resolve();

	// Relationships are rows added and removed one at a time, not part of
	// the debounced field autosave.
	// svelte-ignore state_referenced_locally
	const ENTITY_TYPE = kind === 'lore' ? 'lore_entry' : kind;
	const applicableTypes = $derived(
		relationTypes.filter((relationType) => relationType.fromType === ENTITY_TYPE)
	);
	const relCategories = $derived([
		...new Set(applicableTypes.map((relationType) => relationType.category))
	]);
	let relTypeId = $state('');
	let relTargetId = $state('');
	let relNotes = $state('');
	let relError = $state('');
	const relTargetOptions = $derived.by(() => {
		const relationType = relationTypes.find((option) => option.id === relTypeId);
		if (!relationType) return [];
		return (targets[relationType.toType] ?? []).filter((target) => target.id !== entity.id);
	});

	async function addRelationship(event: SubmitEvent) {
		event.preventDefault();
		relError = '';
		const response = await fetch('/api/relationships', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				fromKind: kind,
				fromId: entity.id,
				relationTypeId: relTypeId,
				toId: relTargetId,
				notesMd: relNotes
			})
		});
		if (!response.ok) {
			relError = (await response.json().catch(() => null))?.message ?? 'Could not add that.';
			return;
		}
		relTypeId = '';
		relTargetId = '';
		relNotes = '';
		await invalidateAll();
	}

	async function removeRelationship(relationshipId: string) {
		const response = await fetch(`/api/relationships/${relationshipId}`, { method: 'DELETE' });
		if (response.ok) await invalidateAll();
	}

	async function setMembership(member: boolean) {
		const response = await fetch(`/api/stories/${storyId}/members`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind, entityId: entity.id, member })
		});
		if (response.ok) await invalidateAll();
	}

	async function save() {
		if (!view) return;
		dirty = false;
		report('saving');
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
		<div class="save-control">
			<span class="save-state" class:err={status === 'error'}>
				{#if status === 'saving'}Saving...{:else if status === 'saved'}Saved{:else if status === 'error'}Not
					saved{:else}Autosaves{/if}
			</span>
			<button class="save-now" type="button" onclick={saveNow} disabled={status === 'saving'}>
				Save
			</button>
		</div>
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
		<select
			class="line-input"
			bind:value={categoryValue}
			onchange={scheduleSave}
			aria-label="Category"
		>
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

	{#if applicableTypes.length > 0 || relationships.length > 0}
		<div class="section-label">Relationships</div>
		{#each relationships as relationship (relationship.id)}
			<div class="rel-row">
				<span class="rel-label">{relationship.label}</span>
				<span class="rel-name">{relationship.otherName}</span>
				{#if relationship.notesMd}
					<span class="rel-notes">{relationship.notesMd}</span>
				{/if}
				<button
					class="rel-remove"
					type="button"
					title="Remove relationship"
					onclick={() => removeRelationship(relationship.id)}
				>
					&times;
				</button>
			</div>
		{/each}
		{#if applicableTypes.length > 0}
			<form class="rel-add" onsubmit={addRelationship}>
				<select
					class="line-input"
					bind:value={relTypeId}
					onchange={() => (relTargetId = '')}
					aria-label="Relation"
				>
					<option value="">Add a relationship...</option>
					{#each relCategories as category (category)}
						<optgroup label={category ?? 'Other'}>
							{#each applicableTypes.filter((option) => option.category === category) as option (option.id)}
								<option value={option.id}>{option.forwardLabel}</option>
							{/each}
						</optgroup>
					{/each}
				</select>
				{#if relTypeId}
					<select class="line-input" bind:value={relTargetId} aria-label="Related entity">
						<option value="">Who or where...</option>
						{#each relTargetOptions as target (target.id)}
							<option value={target.id}>{target.name}</option>
						{/each}
					</select>
					<input
						class="line-input"
						type="text"
						placeholder="Notes (optional)"
						bind:value={relNotes}
					/>
					<button class="outline-add" type="submit" disabled={!relTargetId}>Add</button>
				{/if}
				{#if relError}
					<p class="rel-error" role="alert">{relError}</p>
				{/if}
			</form>
		{/if}
	{/if}

	{#if storyId}
		<div class="section-label">In this book</div>
		{#if membership}
			<div class="member-row">
				{#if membership.member}
					<span class="member-note">Declared in this story.</span>
					<button class="member-btn" type="button" onclick={() => setMembership(false)}>
						Remove from this story
					</button>
				{:else}
					{#if membership.mentioned}
						<span class="member-note">Mentioned in this story's prose.</span>
					{/if}
					<button class="member-btn" type="button" onclick={() => setMembership(true)}>
						Appears in this story
					</button>
				{/if}
			</div>
		{/if}
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
	.rel-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 6px 2px;
		border-bottom: 1px dashed var(--border);
		font-size: 13.5px;
	}
	.rel-label {
		color: var(--text-muted);
		white-space: nowrap;
	}
	.rel-name {
		color: var(--text);
		font-weight: 550;
	}
	.rel-notes {
		flex: 1;
		min-width: 0;
		color: var(--text-faint);
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rel-remove {
		margin-left: auto;
		border: 0;
		background: none;
		color: var(--text-faint);
		font-size: 15px;
		line-height: 1;
		cursor: pointer;
	}
	.rel-remove:hover {
		color: var(--danger, #b00020);
	}
	.rel-add {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 8px;
	}
	.rel-error {
		color: var(--danger, #b00020);
		font-size: 12.5px;
		margin: 0;
	}
	.member-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
		margin-bottom: 8px;
	}
	.member-note {
		color: var(--text-muted);
	}
	.member-btn {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		background: none;
		color: var(--text-muted);
		font-size: 12.5px;
		padding: 5px 10px;
		cursor: pointer;
	}
	.member-btn:hover {
		color: var(--text);
		border-color: var(--accent-line);
	}
</style>
