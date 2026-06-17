<script lang="ts" module>
	export type EntityKind = 'character' | 'place' | 'lore';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { EditorView } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';
	import TagInput from './TagInput.svelte';
	import EntityBadgePicker from './EntityBadgePicker.svelte';
	import EntityRelationships, {
		type RelationTypeOption,
		type RelationshipRow
	} from './EntityRelationships.svelte';
	import { createAutosave } from '$lib/autosave';
	import type { SaveStatus } from '$lib/autosave';
	import { apiErrorMessage, pluralSuffix } from '$lib/format';

	let {
		kind,
		entity,
		categories = [],
		assetsConfigured = false,
		relationTypes = [],
		relationships = [],
		targets = {},
		storyId,
		storyNotesMd,
		membership = null,
		entityHref,
		universeRef,
		assistantEnabled = false,
		assistantSuggestions = [],
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
			badgeColor?: string | null;
			badgeAssetId?: string | null;
		};
		categories?: { id: string; name: string; color: string | null }[];
		// Image uploads only appear when an asset bucket is configured.
		assetsConfigured?: boolean;
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
		// The Assistant can suggest aliases, details, and a summary for this entity
		// (needs a story for the appearances it reads, and the account on).
		assistantEnabled?: boolean;
		// Pending Assistant suggestions for this entity, awaiting accept or reject.
		assistantSuggestions?: AssistantSuggestion[];
		onStatus: (status: SaveStatus) => void;
	} = $props();

	type AssistantSuggestion = {
		id: string;
		field: 'alias' | 'detail' | 'summary';
		label: string | null;
		value: string;
	};

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

	// Assistant suggestions for this entity. Seeded from the prop, then grown by
	// "Suggest details" and pruned as the writer accepts or rejects each one.
	// svelte-ignore state_referenced_locally
	let suggestions = $state<AssistantSuggestion[]>([...assistantSuggestions]);
	let enriching = $state(false);
	let enrichNote = $state('');

	async function runEnrich() {
		if (enriching || !storyId) return;
		enriching = true;
		enrichNote = '';
		try {
			const response = await fetch('/api/assistant/enrich', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ storyId, entityId: entity.id })
			});
			if (!response.ok) {
				enrichNote = await apiErrorMessage(response, 'The Assistant could not suggest anything.');
				return;
			}
			const body = (await response.json()) as { suggestions: AssistantSuggestion[] };
			const fresh = body.suggestions.filter((s) => !suggestions.some((p) => p.id === s.id));
			suggestions = [...suggestions, ...fresh];
			if (fresh.length === 0) enrichNote = 'Nothing new to suggest from this story.';
		} catch {
			enrichNote = 'Something went wrong reaching the Assistant.';
		} finally {
			enriching = false;
		}
	}

	// Apply an accepted suggestion to the open editor's state so it shows at once;
	// the server already persisted it, so this does not trigger a save.
	function applyLocally(s: AssistantSuggestion) {
		if (s.field === 'summary') {
			summary = s.value;
		} else if (s.field === 'detail') {
			details = [...details, { label: s.label ?? '', value: s.value }];
		} else if (kind === 'lore') {
			if (!keywords.includes(s.value)) keywords = [...keywords, s.value];
		} else {
			if (!aliases.includes(s.value)) aliases = [...aliases, s.value];
		}
	}

	async function decideSuggestion(s: AssistantSuggestion, decision: 'accept' | 'reject') {
		const response = await fetch(`/api/assistant/entity-suggestions/${s.id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ decision })
		});
		if (!response.ok) {
			enrichNote = 'Could not update that suggestion.';
			return;
		}
		if (decision === 'accept') applyLocally(s);
		suggestions = suggestions.filter((p) => p.id !== s.id);
	}

	function suggestionLabel(s: AssistantSuggestion): string {
		if (s.field === 'summary') return 'Summary';
		if (s.field === 'detail') return s.label ?? 'Detail';
		return kind === 'lore' ? 'Keyword' : 'Alias';
	}

	// The category's colour tints the badge when no override is set.
	const categoryColor = $derived(categories.find((c) => c.id === categoryValue)?.color ?? null);

	const autosave = createAutosave({
		debounceMs: SAVE_DEBOUNCE_MS,
		onStatus: (status) => onStatus(status),
		save: async ({ keepalive }) => {
			if (!view) return;
			const response = await fetch(`/api/${ENDPOINT}/${entity.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				keepalive,
				body: JSON.stringify(savePayload(view.state.doc.toString()))
			});
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
		},
		// Only a settled rename makes the offer; mid-typing saves skip it.
		onSettled: () => void checkRename()
	});
	const scheduleSave = autosave.schedule;

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

	// The full set of editable fields, shared by the debounced save and the
	// page-hide flush so both write the same shape.
	function savePayload(bodyMd: string): Record<string, unknown> {
		const payload: Record<string, unknown> = {
			name,
			summaryMd: summary,
			bodyMd,
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
		return payload;
	}

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: entity.bodyMd,
				extensions: proseExtensions({
					placeholder: BODY_PLACEHOLDER,
					onDocChanged: scheduleSave,
					// Descriptions are notes, not manuscript: plain prose with no
					// markdown styling. Existing text is stored untouched.
					plain: true
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
		<EntityBadgePicker
			entityId={entity.id}
			name={entity.name}
			{assetsConfigured}
			{categoryColor}
			badgeColor={entity.badgeColor ?? null}
			badgeAssetId={entity.badgeAssetId ?? null}
		/>
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
				place{pluralSuffix(renameOffer.occurrences)} in {renameOffer.scenes}
				scene{pluralSuffix(renameOffer.scenes)}.
			</span>
			<span class="rename-actions">
				<button class="btn btn-primary" type="button" disabled={renameBusy} onclick={applyRename}>
					Replace
				</button>
				<button class="btn btn-secondary" type="button" onclick={dismissRename}>Dismiss</button>
			</span>
		</div>
	{/if}

	{#if assistantEnabled && storyId}
		<div class="assist-enrich">
			<button class="btn btn-secondary" type="button" disabled={enriching} onclick={runEnrich}>
				{enriching ? 'Thinking...' : 'Suggest details with the Assistant'}
			</button>
			{#if enrichNote}
				<span class="assist-note">{enrichNote}</span>
			{/if}
		</div>
	{/if}

	{#if suggestions.length > 0}
		<div class="assist-suggestions">
			<div class="section-label">Assistant suggestions</div>
			<p class="field-hint">Drawn from where this entry appears in your prose. Accept to add it.</p>
			{#each suggestions as s (s.id)}
				<div class="assist-row">
					<span class="assist-kind">{suggestionLabel(s)}</span>
					<span class="assist-value">{s.value}</span>
					<span class="assist-actions">
						<button
							class="btn btn-primary btn-sm"
							type="button"
							onclick={() => decideSuggestion(s, 'accept')}
						>
							Accept
						</button>
						<button
							class="btn btn-secondary btn-sm"
							type="button"
							onclick={() => decideSuggestion(s, 'reject')}
						>
							Reject
						</button>
					</span>
				</div>
			{/each}
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

	<EntityRelationships
		{kind}
		entityId={entity.id}
		{relationTypes}
		{relationships}
		{targets}
		{entityHref}
	/>

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
	.assist-enrich {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin: 12px 0 0;
	}
	.assist-note {
		font-size: 12.5px;
		color: var(--text-faint);
	}
	.assist-suggestions {
		margin-top: 12px;
		padding: 10px 12px;
		border: 1px solid var(--accent-line);
		border-radius: 10px;
		background: var(--bg-card);
	}
	.assist-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 0;
		border-top: 1px solid var(--border);
	}
	.assist-row:first-of-type {
		border-top: 0;
	}
	.assist-kind {
		flex: none;
		min-width: 64px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	.assist-value {
		flex: 1;
		font-size: 13.5px;
		color: var(--text);
	}
	.assist-actions {
		display: inline-flex;
		gap: 6px;
		flex: none;
	}
	.btn-sm {
		padding: 4px 10px;
		font-size: 12.5px;
	}

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
