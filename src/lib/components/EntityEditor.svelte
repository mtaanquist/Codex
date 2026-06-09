<script lang="ts" module>
	export type EntityKind = 'character' | 'place' | 'lore';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { EditorView } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { proseExtensions } from '$lib/editor';
	import { CATEGORY_COLORS, entityColor } from '$lib/entity-color';
	import EntityBadge from './EntityBadge.svelte';
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
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				enrichNote = body?.message ?? 'The Assistant could not suggest anything.';
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

	// The badge override and its little menu. Colour and image post straight to
	// the badge endpoint (not the debounced field save), then the page data
	// refresh carries the change to the sidebar and the rest.
	// svelte-ignore state_referenced_locally
	let badgeColor = $state(entity.badgeColor ?? null);
	// svelte-ignore state_referenced_locally
	let badgeAssetId = $state(entity.badgeAssetId ?? null);
	let badgeMenuOpen = $state(false);
	let badgeWrap = $state<HTMLElement>();
	const categoryColor = $derived(categories.find((c) => c.id === categoryValue)?.color ?? null);

	$effect(() => {
		if (!badgeMenuOpen) return;
		const onClick = (event: MouseEvent) => {
			if (badgeWrap && !badgeWrap.contains(event.target as Node)) badgeMenuOpen = false;
		};
		window.addEventListener('click', onClick, true);
		return () => window.removeEventListener('click', onClick, true);
	});

	async function pickBadgeColour(color: string | null) {
		badgeColor = color;
		badgeMenuOpen = false;
		await fetch(`/api/entities/${entity.id}/badge`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ color })
		}).catch(() => {});
		await invalidateAll();
	}

	async function uploadBadgeImage(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		badgeMenuOpen = false;
		const data = new FormData();
		data.set('file', file);
		const response = await fetch(`/api/entities/${entity.id}/badge`, {
			method: 'POST',
			body: data
		});
		if (response.ok) {
			badgeAssetId = (await response.json()).id;
			await invalidateAll();
		}
	}

	async function removeBadgeImage() {
		badgeMenuOpen = false;
		const response = await fetch(`/api/entities/${entity.id}/badge`, { method: 'DELETE' });
		if (response.ok) {
			badgeAssetId = null;
			await invalidateAll();
		}
	}

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
	function cancelRelationship() {
		addingRel = false;
		relTypeId = '';
		relTargetId = '';
		relNotes = '';
		relError = '';
	}
	function onRelKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') cancelRelationship();
	}
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
					onDocChanged: scheduleSave,
					// Descriptions are notes, not manuscript: plain prose with no
					// markdown styling. Existing text is stored untouched.
					plain: true
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
		<div class="badge-pick" bind:this={badgeWrap}>
			<button
				class="badge-pick-btn"
				type="button"
				aria-haspopup="menu"
				aria-expanded={badgeMenuOpen}
				title="Change the badge colour or image"
				onclick={() => (badgeMenuOpen = !badgeMenuOpen)}
			>
				<EntityBadge name={entity.name} {badgeColor} {badgeAssetId} {categoryColor} size="lg" />
			</button>
			{#if badgeMenuOpen}
				<div class="badge-menu" role="menu">
					{#if badgeAssetId}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a class="badge-menu-item" role="menuitem" href="/assets/{badgeAssetId}" download>
							Download image
						</a>
						<button
							class="badge-menu-item"
							type="button"
							role="menuitem"
							onclick={removeBadgeImage}
						>
							Remove image
						</button>
					{:else}
						<div class="badge-swatches">
							<button
								class="swatch swatch-default"
								class:active={!badgeColor}
								type="button"
								title="Default colour"
								aria-label="Default colour"
								onclick={() => pickBadgeColour(null)}
							></button>
							{#each CATEGORY_COLORS as choice (choice.token)}
								<button
									class="swatch"
									class:active={badgeColor === choice.token}
									type="button"
									style="background: {choice.token}"
									title={choice.label}
									aria-label={choice.label}
									onclick={() => pickBadgeColour(choice.token)}
								></button>
							{/each}
						</div>
						{#if assetsConfigured}
							<label class="badge-menu-item badge-upload">
								Upload image
								<input
									type="file"
									accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
									onchange={uploadBadgeImage}
									hidden
								/>
							</label>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
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
						onkeydown={onRelKeydown}
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
						<select
							class="line-input"
							bind:value={relTargetId}
							onkeydown={onRelKeydown}
							aria-label="Related entity"
						>
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
							onkeydown={onRelKeydown}
						/>
					{/if}
					<div class="rel-add-actions">
						<button class="outline-add" type="submit" disabled={!relTargetId}>Add</button>
						<button class="rel-cancel" type="button" onclick={cancelRelationship}> Cancel </button>
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
	/* The badge picker: the large badge is a button that drops a small menu of
	   palette swatches and the image actions. */
	.badge-pick {
		position: relative;
		flex: none;
	}
	.badge-pick-btn {
		display: block;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		border-radius: 18px;
	}
	.badge-pick-btn:hover {
		opacity: 0.9;
	}
	.badge-menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 20;
		min-width: 184px;
		padding: 8px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
	}
	.badge-swatches {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 6px;
		margin-bottom: 6px;
	}
	.swatch {
		width: 22px;
		height: 22px;
		border-radius: 7px;
		border: 2px solid transparent;
		cursor: pointer;
		padding: 0;
	}
	.swatch.active {
		border-color: var(--text);
	}
	.swatch-default {
		background: linear-gradient(
			135deg,
			transparent calc(50% - 1px),
			var(--border-strong) calc(50% - 1px),
			var(--border-strong) calc(50% + 1px),
			transparent calc(50% + 1px)
		);
		box-shadow: inset 0 0 0 1px var(--border);
	}
	.badge-menu-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 7px 8px;
		border: 0;
		border-radius: 7px;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		text-decoration: none;
	}
	.badge-menu-item:hover {
		background: var(--bg-hover);
	}
	.badge-upload {
		cursor: pointer;
	}

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
