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
	import TagInput from './TagInput.svelte';
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
		entityHref,
		universeRef,
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
			details?: { label: string; value: string }[];
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
		// Builds the Plan link for a related entity, scoped to story or universe.
		entityHref?: (entityId: string) => string;
		// When set, a settled rename offers to replace the old name across the
		// universe's prose (the universe slug for the API path).
		universeRef?: string;
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
	let aliases = $state([...(entity.aliases ?? [])]);
	// svelte-ignore state_referenced_locally
	let keywords = $state([...(entity.keywords ?? [])]);
	// svelte-ignore state_referenced_locally
	let categoryValue = $state(entity.categoryId ?? '');
	// svelte-ignore state_referenced_locally
	let summary = $state(entity.summaryMd ?? '');
	// svelte-ignore state_referenced_locally
	let details = $state((entity.details ?? []).map((detail) => ({ ...detail })));
	// svelte-ignore state_referenced_locally
	let notes = $state(storyNotesMd ?? '');
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
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
	let addingRel = $state(false);
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
		addingRel = false;
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

	// Rename propagation: once a rename settles (a save lands and no edit
	// followed), offer to sweep the old name out of the universe's prose.
	// The baseline is the name this editor opened with, or the last one a
	// sweep or dismissal accepted.
	// svelte-ignore state_referenced_locally
	let renameFrom = $state(entity.name);
	let renameOffer = $state<{ from: string; scenes: number; occurrences: number } | null>(null);
	let renameBusy = $state(false);

	async function checkRename() {
		const from = renameFrom;
		const to = name.trim();
		if (!universeRef || !to || to === from) return;
		const response = await fetch(
			`/api/universes/${universeRef}/prose-replace?q=${encodeURIComponent(from)}`
		);
		if (!response.ok) return;
		const counts = (await response.json()) as { scenes: number; occurrences: number };
		if (counts.occurrences === 0) {
			// Nothing to sweep; the new name becomes the baseline quietly.
			renameFrom = to;
			renameOffer = null;
			return;
		}
		renameOffer = { from, ...counts };
	}

	async function applyRename() {
		if (!renameOffer || renameBusy) return;
		renameBusy = true;
		try {
			const response = await fetch(`/api/universes/${universeRef}/prose-replace`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ find: renameOffer.from, replace: name.trim() })
			});
			if (!response.ok) return;
			renameFrom = name.trim();
			renameOffer = null;
			await invalidateAll();
		} finally {
			renameBusy = false;
		}
	}

	function dismissRename() {
		renameFrom = name.trim();
		renameOffer = null;
	}

	// The details grid shows saved cells read-only and edits one at a time.
	// Edits write straight into the array (the debounced autosave already
	// covers them); closing just prunes rows left fully blank.
	let editingDetail = $state<number | null>(null);

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}

	function pruneEmptyDetails() {
		const before = details.length;
		for (let i = details.length - 1; i >= 0; i--) {
			if (!details[i].label.trim() && !details[i].value.trim()) details.splice(i, 1);
		}
		if (details.length !== before) scheduleSave();
	}

	// By identity, because pruning the abandoned blank row shifts indexes.
	function openDetail(target: { label: string; value: string }) {
		pruneEmptyDetails();
		const index = details.indexOf(target);
		editingDetail = index >= 0 ? index : null;
	}

	function addDetail() {
		details.push({ label: '', value: '' });
		editingDetail = details.length - 1;
	}

	function closeDetails() {
		editingDetail = null;
		pruneEmptyDetails();
	}

	function onDetailKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			// Save & add another; a blank row just closes instead of piling up.
			const current = editingDetail === null ? null : details[editingDetail];
			if (!current || (!current.label.trim() && !current.value.trim())) closeDetails();
			else addDetail();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			closeDetails();
		}
	}

	// Focus leaving the editing cell closes it. Deferred, because moving
	// between the cell's own inputs (or into the replacement cell after
	// "add another") is not leaving.
	function onDetailFocusOut() {
		setTimeout(() => {
			if (editingDetail === null) return;
			const active = document.activeElement;
			if (active instanceof HTMLElement && active.closest('.detail-editing')) return;
			closeDetails();
		}, 0);
	}

	async function save() {
		if (!view) return;
		dirty = false;
		onStatus('saving');
		try {
			const payload: Record<string, unknown> = {
				name,
				summaryMd: summary,
				bodyMd: view.state.doc.toString(),
				details
			};
			if (storyId) {
				payload.storyId = storyId;
				payload.storyNotesMd = notes;
			}
			if (kind === 'character' || kind === 'place') {
				payload.aliases = aliases;
			}
			if (kind === 'lore') {
				payload.keywords = keywords;
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
			// Only a settled rename makes the offer; mid-typing saves skip it.
			if (!dirty) void checkRename();
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

	{#if renameOffer}
		<div class="rename-offer" role="status">
			<span class="rename-text">
				Renamed from "{renameOffer.from}". Replace it in the text? {renameOffer.occurrences}
				place{renameOffer.occurrences === 1 ? '' : 's'} in {renameOffer.scenes}
				scene{renameOffer.scenes === 1 ? '' : 's'}.
			</span>
			<span class="rename-actions">
				<button class="btn btn-primary" type="button" disabled={renameBusy} onclick={applyRename}>
					Replace
				</button>
				<button class="btn btn-secondary" type="button" onclick={dismissRename}>Dismiss</button>
			</span>
		</div>
	{/if}

	{#if kind === 'character' || kind === 'place'}
		<div class="section-label">Aliases</div>
		<p class="field-hint">
			{kind === 'character'
				? 'Nicknames and variants used to spot mentions in your prose.'
				: 'Nicknames and local names used to spot mentions in your prose.'}
		</p>
		<TagInput
			values={aliases}
			onChange={(next) => {
				aliases = next;
				scheduleSave();
			}}
			addLabel="Add alias"
			ariaLabel="Add alias"
		/>
	{/if}

	{#if kind === 'lore'}
		<div class="section-label">Keywords</div>
		<p class="field-hint">
			Other names and terms that refer to this entry; they work like aliases and are used to spot
			mentions in your prose.
		</p>
		<TagInput
			values={keywords}
			onChange={(next) => {
				keywords = next;
				scheduleSave();
			}}
			addLabel="Add keyword"
			ariaLabel="Add keyword"
		/>
	{/if}

	<!-- Lore entries live in a category; for characters and places, who
	     already are their own kind, the same field only lends the sidebar
	     badge its colour, so it is named for what it does. -->
	{#if categories.length > 0}
		{@const label = kind === 'lore' ? 'Category' : 'Colour group'}
		<div class="section-label">{label}</div>
		{#if kind !== 'lore'}
			<p class="field-hint">Tints this name's badge in the sidebar with the group's colour.</p>
		{/if}
		<select
			class="line-input"
			bind:value={categoryValue}
			onchange={scheduleSave}
			aria-label={label}
		>
			{#if kind !== 'lore'}
				<option value="">None</option>
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
		{#if relationships.length > 0}
			<div class="rel-list">
				{#each relationships as relationship (relationship.id)}
					<div class="rel-row">
						<span class="rel-type">{relationship.label}</span>
						{#if entityHref}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller passes a resolved Plan path plus a query string) -->
							<a class="rel-target" href={entityHref(relationship.otherId)}>
								<span class="badge dot" style="background: {entityColor(relationship.otherName)}"
								></span>
								<span>{relationship.otherName}</span>
							</a>
						{:else}
							<span class="rel-target">
								<span class="badge dot" style="background: {entityColor(relationship.otherName)}"
								></span>
								<span>{relationship.otherName}</span>
							</span>
						{/if}
						{#if relationship.notesMd}
							<span class="rel-note">{relationship.notesMd}</span>
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
			</div>
		{/if}
		{#if applicableTypes.length > 0}
			{#if addingRel}
				<form class="rel-add" onsubmit={addRelationship}>
					<select
						class="line-input"
						bind:value={relTypeId}
						onchange={() => (relTargetId = '')}
						aria-label="Relation"
					>
						<option value="">Pick a relationship...</option>
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
					{/if}
					<div class="rel-add-actions">
						<button class="outline-add" type="submit" disabled={!relTargetId}>Add</button>
						<button
							class="rel-cancel"
							type="button"
							onclick={() => {
								addingRel = false;
								relTypeId = '';
								relTargetId = '';
								relNotes = '';
								relError = '';
							}}
						>
							Cancel
						</button>
					</div>
					{#if relError}
						<p class="rel-error" role="alert">{relError}</p>
					{/if}
				</form>
			{:else}
				<button type="button" class="chip dashed rel-add-chip" onclick={() => (addingRel = true)}>
					+ Add relationship
				</button>
			{/if}
		{/if}
	{/if}

	<div class="section-label">Details</div>
	<p class="field-hint">Short facts shown with this entry, like Status or Age.</p>
	{#if details.length > 0}
		<div class="fields">
			{#each details as detail, index (index)}
				{#if editingDetail === index}
					<div class="field detail-editing" onfocusout={onDetailFocusOut}>
						<input
							class="detail-k"
							type="text"
							placeholder="Label"
							bind:value={detail.label}
							oninput={scheduleSave}
							onkeydown={onDetailKeydown}
							use:focusOnMount
							aria-label="Detail label"
						/>
						<div class="detail-v-row">
							<input
								class="detail-v"
								type="text"
								placeholder="Value"
								bind:value={detail.value}
								oninput={scheduleSave}
								onkeydown={onDetailKeydown}
								aria-label="Detail value"
							/>
							<button
								class="detail-remove"
								type="button"
								title="Remove detail"
								onclick={() => {
									details.splice(index, 1);
									editingDetail = null;
									scheduleSave();
								}}
							>
								&times;
							</button>
						</div>
					</div>
				{:else}
					<button type="button" class="field detail-cell" onclick={() => openDetail(detail)}>
						<div class="k">{detail.label}</div>
						<div class="v">{detail.value}</div>
					</button>
				{/if}
			{/each}
			{#if details.length % 2 === 1}
				<div class="field detail-filler"></div>
			{/if}
		</div>
	{/if}
	{#if editingDetail !== null}
		<p class="details-foot">
			<kbd>&#9166;</kbd> save & add another <span class="sep">&middot;</span>
			<kbd>esc</kbd> done
		</p>
	{:else}
		<button type="button" class="chip dashed detail-add-chip" onclick={addDetail}>
			+ Add detail
		</button>
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
	.rename-offer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin: 10px 0 0;
		padding: 10px 12px;
		border: 1px solid var(--accent-line, var(--accent));
		border-radius: var(--radius, 9px);
		background: var(--accent-soft);
		font-size: 13px;
	}
	.rename-text {
		flex: 1;
		min-width: 200px;
	}
	.rename-actions {
		display: inline-flex;
		gap: 8px;
		flex: none;
	}
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
	.field-hint {
		color: var(--text-faint);
		font-size: 12.5px;
		margin: -4px 0 4px;
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
	.rel-add {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 10px;
	}
	.rel-add-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.rel-cancel {
		border: 0;
		background: none;
		color: var(--text-muted);
		font-size: 12.5px;
		padding: 5px 8px;
		cursor: pointer;
	}
	.rel-cancel:hover {
		color: var(--text);
	}
	.rel-add-chip {
		margin-top: 10px;
	}
	/* Editable cells inside the design system's .fields grid: the inputs
	   carry the .k / .v typography. */
	.detail-k,
	.detail-v {
		width: 100%;
		border: 0;
		background: none;
		color: var(--text);
		outline: none;
		padding: 0;
	}
	.detail-k {
		font-size: 11px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin-bottom: 4px;
	}
	.detail-k::placeholder,
	.detail-v::placeholder {
		color: var(--text-faint);
		text-transform: none;
		letter-spacing: normal;
	}
	.detail-v {
		font-size: 14px;
	}
	.detail-v-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.detail-remove {
		border: 0;
		background: none;
		color: var(--text-faint);
		font-size: 14px;
		line-height: 1;
		padding: 0 2px;
		cursor: pointer;
	}
	.detail-remove:hover {
		color: var(--text);
	}
	.detail-add-chip {
		margin-top: 10px;
	}
	/* Saved details read as plain cells; click one to edit it. */
	.detail-cell {
		display: block;
		width: 100%;
		text-align: left;
		border: 0;
		font: inherit;
		cursor: pointer;
	}
	.detail-cell:hover {
		background: var(--bg-hover);
	}
	.detail-editing {
		box-shadow: inset 0 0 0 1.5px var(--accent-line);
	}
	/* Completes the row when the count is odd, so the grid's gap colour
	   never shows as a big empty block. */
	.detail-filler {
		background: var(--bg-inset);
	}
	.details-foot {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-faint);
		font-family: var(--font-ui);
		font-size: 11.5px;
		margin: 8px 0 0;
	}
	.details-foot kbd {
		font-family: var(--font-mono);
		font-size: 10.5px;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 0 4px;
	}
	.details-foot .sep {
		color: var(--text-faint);
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
