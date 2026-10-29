<script lang="ts">
	import { withQuery } from '#lib/href';
	import type { ResolvedPathname } from '$app/types';
	import { tick, untrack } from 'svelte';
	import { LEFT_PANE_LABEL } from '#lib/chrome';
	import Icon from './Icon.svelte';
	import FormStatus from './FormStatus.svelte';
	import SidebarSearch from './SidebarSearch.svelte';
	import EntityBadge from './EntityBadge.svelte';
	import ModeSwitcher from './ModeSwitcher.svelte';

	// A character or place row: its category colour plus any per-entity badge
	// override (colour or uploaded image).
	type Entity = {
		id: string;
		name: string;
		color: string | null;
		badgeColor: string | null;
		badgeAssetId: string | null;
	};

	// The left pane of a Plan view, shared by the story and universe scopes.
	// Entity links keep the current page and swap the ?entity= query; the
	// create forms post to actions both pages define under the same names.
	let {
		characters,
		places,
		categories,
		lore,
		selectedId,
		planPath,
		writeHref,
		reviewHref,
		modeNote,
		insightsHref,
		categoriesHref,
		boardHref,
		boardActive = false,
		boardLabel = 'Scene board',
		form,
		availableCharacters = [],
		availablePlaces = []
	}: {
		characters: Entity[];
		places: Entity[];
		categories: { id: string; name: string; color: string | null }[];
		lore: {
			id: string;
			name: string;
			categoryId: string;
			badgeColor: string | null;
			badgeAssetId: string | null;
		}[];
		selectedId?: string;
		planPath: ResolvedPathname;
		// At universe scope both point at the universe's own story list, which
		// is where you pick the story to write in or review.
		writeHref?: ResolvedPathname;
		reviewHref?: ResolvedPathname;
		// The line under the mode strip, when the strip needs explaining.
		modeNote?: string;
		// Universe scope only: insights covers the whole universe, so it sits
		// at the foot of the sidebar rather than beside a single story.
		insightsHref?: ResolvedPathname;
		// The universe settings section where categories are made and edited.
		categoriesHref: ResolvedPathname;
		// Returns to the board after something else filled the centre: the
		// scene board at story scope, the story board at universe scope.
		boardHref?: ResolvedPathname;
		boardActive?: boolean;
		boardLabel?: string;
		form: {
			kind?: string;
			message?: string;
			categoryId?: string;
			memberKind?: string;
		} | null;
		// Universe entities not in the story yet: browsable below the members,
		// and picking one in the select declares it a member. Story scope only.
		availableCharacters?: Entity[];
		availablePlaces?: Entity[];
	} = $props();

	// The universe lists start open so the wider cast stays in view; the
	// fold is there to reclaim the space when the lists grow long.
	let showUniverseCharacters = $state(true);
	let showUniversePlaces = $state(true);

	// The filter narrows every list by name; while it is active the create
	// forms step aside and the folded lists open to show their matches.
	let query = $state('');
	const q = $derived(query.trim().toLowerCase());
	function nameMatch(name: string) {
		return name.toLowerCase().includes(q);
	}
	const visibleCharacters = $derived(
		q === '' ? characters : characters.filter((row) => nameMatch(row.name))
	);
	const visiblePlaces = $derived(q === '' ? places : places.filter((row) => nameMatch(row.name)));
	const visibleAvailableCharacters = $derived(
		q === '' ? availableCharacters : availableCharacters.filter((row) => nameMatch(row.name))
	);
	const visibleAvailablePlaces = $derived(
		q === '' ? availablePlaces : availablePlaces.filter((row) => nameMatch(row.name))
	);
	// Each group shows one "Add" row; picking it swaps in that group's field.
	// Escape or opening another row closes it. It does not close on blur:
	// that would shift the rows under a click on the next one. One open at a
	// time, keyed 'character', 'place', 'lore:<categoryId>' or
	// 'member:<kind>'.
	function keyOf(result: typeof form): string | null {
		if (!result?.message) return null;
		if (result.kind === 'lore') return `lore:${result.categoryId}`;
		if (result.kind === 'member') return `member:${result.memberKind}`;
		return result.kind ?? null;
	}
	// A failed submit reloads the page; open the form it came from so the
	// message renders beside the field. Closing that form drops the message.
	const failedKey = untrack(() => keyOf(form));
	let adding = $state<string | null>(failedKey);
	let errorKey = $state<string | null>(failedKey);

	function errorFor(key: string): string | null {
		return errorKey === key ? (form?.message ?? null) : null;
	}
	// A lore failure for a category deleted in the meantime has no row to sit on.
	const orphanError = $derived(
		form?.message && form.kind === 'lore' && !categories.some((c) => c.id === form.categoryId)
			? form.message
			: null
	);

	// Escape closes the field and puts focus back on its Add row.
	async function closeAdd(key: string) {
		adding = null;
		errorKey = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-add="${key}"]`)?.focus();
	}
	function onAddKeydown(event: KeyboardEvent, key: string) {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeAdd(key);
		}
	}

	const anyMatch = $derived(
		q === '' ||
			visibleCharacters.length > 0 ||
			visiblePlaces.length > 0 ||
			visibleAvailableCharacters.length > 0 ||
			visibleAvailablePlaces.length > 0 ||
			lore.some((entry) => nameMatch(entry.name))
	);
</script>

{#snippet addToggle(key: string, label: string)}
	<button
		class="outline-add add-row"
		type="button"
		data-add={key}
		onclick={() => {
			adding = key;
			errorKey = null;
		}}
	>
		<Icon name="plus" size={13} />
		{label}
	</button>
{/snippet}

{#snippet addName(
	key: string,
	action: string,
	label: string,
	fieldLabel: string,
	placeholder: string,
	categoryId?: string
)}
	{#if adding === key}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions (catches Escape bubbling from the field and its button) -->
		<form method="POST" {action} class="new-entity" onkeydown={(event) => onAddKeydown(event, key)}>
			{#if categoryId}<input type="hidden" name="categoryId" value={categoryId} />{/if}
			<label class="visually-hidden" for="add-{key}">{fieldLabel}</label>
			<!-- svelte-ignore a11y_autofocus (the field only appears on the Add row's click) -->
			<input
				id="add-{key}"
				class="input"
				type="text"
				name="name"
				{placeholder}
				required
				autofocus
			/>
			<FormStatus error={errorFor(key)} block />
			<button class="outline-add" type="submit">
				<Icon name="plus" size={13} />
				{label}
			</button>
		</form>
	{:else}
		{@render addToggle(key, label)}
	{/if}
{/snippet}

{#snippet addMember(kind: 'character' | 'place', candidates: Entity[])}
	{@const key = `member:${kind}`}
	{#if adding === key}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions (catches Escape bubbling from the field and its button) -->
		<form
			method="POST"
			action="?/declareMember"
			class="new-entity"
			onkeydown={(event) => onAddKeydown(event, key)}
		>
			<input type="hidden" name="kind" value={kind} />
			<label class="visually-hidden" for="add-{key}">A {kind} from the universe</label>
			<!-- svelte-ignore a11y_autofocus (the field only appears on the Add row's click) -->
			<select id="add-{key}" class="select" name="entityId" required autofocus>
				<option value="">From the universe...</option>
				{#each candidates as candidate (candidate.id)}
					<option value={candidate.id}>{candidate.name}</option>
				{/each}
			</select>
			<FormStatus error={errorFor(key)} block />
			<button class="outline-add" type="submit">
				<Icon name="plus" size={13} /> Add to this story
			</button>
		</form>
	{:else}
		{@render addToggle(key, `Add a ${kind} from the universe`)}
	{/if}
{/snippet}

<aside class="pane left" aria-label={LEFT_PANE_LABEL}>
	<div class="left-head">
		<ModeSwitcher active="plan" hrefs={{ write: writeHref, review: reviewHref }} note={modeNote} />
		<SidebarSearch bind:query placeholder="Filter characters, places, lore..." />
	</div>
	<div class="left-scroll">
		{#if boardHref}
			<a class="board-row" class:active={boardActive} href={boardHref}>
				<Icon name="chapter" size={13} />
				{boardLabel}
			</a>
		{/if}
		<div class="group-label">
			<span class="gl-left">Characters</span>
			<span class="count">{visibleCharacters.length}</span>
		</div>
		{#each visibleCharacters as character (character.id)}
			<a
				class="ent-row"
				class:active={character.id === selectedId}
				href={withQuery(planPath, { entity: character.id })}
			>
				<EntityBadge
					name={character.name}
					badgeColor={character.badgeColor}
					badgeAssetId={character.badgeAssetId}
					categoryColor={character.color}
				/>
				<span class="name">{character.name}</span>
			</a>
		{/each}
		{#if q === ''}
			{@render addName(
				'character',
				'?/createCharacter',
				'Add character',
				'Character name',
				'New character name'
			)}
		{/if}
		{#if visibleAvailableCharacters.length > 0}
			<button
				class="uni-toggle"
				type="button"
				onclick={() => (showUniverseCharacters = !showUniverseCharacters)}
			>
				<span class="tw" class:open={q !== '' || showUniverseCharacters}
					><Icon name="chevron" size={11} /></span
				>
				In the universe
				<span class="count">{visibleAvailableCharacters.length}</span>
			</button>
			{#if q !== '' || showUniverseCharacters}
				{#each visibleAvailableCharacters as candidate (candidate.id)}
					<a
						class="ent-row uni-row"
						class:active={candidate.id === selectedId}
						href={withQuery(planPath, { entity: candidate.id })}
					>
						<EntityBadge
							name={candidate.name}
							badgeColor={candidate.badgeColor}
							badgeAssetId={candidate.badgeAssetId}
							categoryColor={candidate.color}
						/>
						<span class="name">{candidate.name}</span>
					</a>
				{/each}
			{/if}
			{#if q === ''}
				{@render addMember('character', availableCharacters)}
			{/if}
		{/if}

		<div class="group-label">
			<span class="gl-left">Places</span>
			<span class="count">{visiblePlaces.length}</span>
		</div>
		{#each visiblePlaces as place (place.id)}
			<a
				class="ent-row"
				class:active={place.id === selectedId}
				href={withQuery(planPath, { entity: place.id })}
			>
				<EntityBadge
					name={place.name}
					badgeColor={place.badgeColor}
					badgeAssetId={place.badgeAssetId}
					categoryColor={place.color}
				/>
				<span class="name">{place.name}</span>
			</a>
		{/each}
		{#if q === ''}
			{@render addName('place', '?/createPlace', 'Add place', 'Place name', 'New place name')}
		{/if}
		{#if visibleAvailablePlaces.length > 0}
			<button
				class="uni-toggle"
				type="button"
				onclick={() => (showUniversePlaces = !showUniversePlaces)}
			>
				<span class="tw" class:open={q !== '' || showUniversePlaces}
					><Icon name="chevron" size={11} /></span
				>
				In the universe
				<span class="count">{visibleAvailablePlaces.length}</span>
			</button>
			{#if q !== '' || showUniversePlaces}
				{#each visibleAvailablePlaces as candidate (candidate.id)}
					<a
						class="ent-row uni-row"
						class:active={candidate.id === selectedId}
						href={withQuery(planPath, { entity: candidate.id })}
					>
						<EntityBadge
							name={candidate.name}
							badgeColor={candidate.badgeColor}
							badgeAssetId={candidate.badgeAssetId}
							categoryColor={candidate.color}
						/>
						<span class="name">{candidate.name}</span>
					</a>
				{/each}
			{/if}
			{#if q === ''}
				{@render addMember('place', availablePlaces)}
			{/if}
		{/if}

		{#each categories as category (category.id)}
			{@const entries = lore.filter(
				(entry) => entry.categoryId === category.id && (q === '' || nameMatch(entry.name))
			)}
			{#if q === '' || entries.length > 0}
				<div class="group-label">
					<span class="gl-left">
						{#if category.color}<span class="cat-dot" style="background: {category.color}"
							></span>{/if}
						{category.name}
					</span>
					<span class="count">{entries.length}</span>
				</div>
				{#each entries as entry (entry.id)}
					<a
						class="ent-row"
						class:active={entry.id === selectedId}
						href={withQuery(planPath, { entity: entry.id })}
					>
						<EntityBadge
							name={entry.name}
							badgeColor={entry.badgeColor}
							badgeAssetId={entry.badgeAssetId}
							categoryColor={category.color}
						/>
						<span class="name">{entry.name}</span>
					</a>
				{/each}
				{#if q === ''}
					{@render addName(
						`lore:${category.id}`,
						'?/createLoreEntry',
						`Add ${category.name} entry`,
						`${category.name} entry name`,
						`New ${category.name} entry`,
						category.id
					)}
				{/if}
			{/if}
		{/each}

		{#if !anyMatch}
			<div class="empty-state tight">
				<p class="empty-state-text">Nothing matches.</p>
			</div>
		{/if}
		<FormStatus error={orphanError} block />
		{#if q === ''}
			<a class="outline-add manage-categories" href={categoriesHref}>
				<Icon name="gear" size={13} /> Manage categories
			</a>
		{/if}
		{#if insightsHref}
			<div class="side-nav-label" id="plan-across-label">Across the universe</div>
			<nav class="side-nav" aria-labelledby="plan-across-label">
				<a href={insightsHref}>Insights</a>
			</nav>
		{/if}
	</div>
</aside>

<style>
	.ent-row {
		text-decoration: none;
		color: inherit;
	}
	.new-entity {
		margin-top: 10px;
		padding: 0 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.add-row {
		margin-top: 4px;
	}
	.manage-categories {
		margin-top: 14px;
		text-decoration: none;
	}
	.board-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 10px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid var(--border);
		color: var(--text);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}
	.board-row:hover {
		background: var(--bg-hover);
	}
	.board-row.active {
		background: var(--bg-active);
		border-color: var(--accent-line, var(--accent));
	}
	/* Styled like the group labels above it, so the universe-wide list
	   reads as a real section rather than an afterthought. */
	.uni-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 14px 8px 6px;
		border: 0;
		background: none;
		color: var(--text-faint);
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		cursor: pointer;
		text-align: left;
	}
	.uni-toggle:hover {
		color: var(--text);
	}
	.uni-toggle .count {
		font-weight: 550;
		letter-spacing: 0;
	}
	.uni-toggle .tw {
		display: grid;
		place-items: center;
	}
	.uni-toggle .tw :global(svg) {
		transition: transform 0.14s;
	}
	.uni-toggle .tw.open :global(svg) {
		transform: rotate(90deg);
	}
	.uni-toggle .count {
		margin-left: auto;
	}
	.uni-row .name {
		color: var(--text-muted);
	}
	.cat-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 99px;
		margin-right: 6px;
	}
</style>
