<script lang="ts">
	import Icon from './Icon.svelte';
	import SidebarSearch from './SidebarSearch.svelte';
	import EntityBadge from './EntityBadge.svelte';
	import { CATEGORY_COLORS } from '$lib/entity-color';
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
		notesHref,
		writeHref,
		reviewHref,
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
		planPath: string;
		// The Notes view at this scope; caller resolves the path.
		notesHref: string;
		// Present at story scope only; the universe Plan has no Write view.
		writeHref?: string;
		// Present at story scope only; the universe Plan has no Review view.
		reviewHref?: string;
		// Returns to the board after something else filled the centre: the
		// scene board at story scope, the story board at universe scope.
		boardHref?: string;
		boardActive?: boolean;
		boardLabel?: string;
		form: { kind?: string; message?: string } | null;
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
	const anyMatch = $derived(
		q === '' ||
			visibleCharacters.length > 0 ||
			visiblePlaces.length > 0 ||
			visibleAvailableCharacters.length > 0 ||
			visibleAvailablePlaces.length > 0 ||
			lore.some((entry) => nameMatch(entry.name))
	);
</script>

<aside class="pane left">
	<div class="left-head">
		<ModeSwitcher
			active="plan"
			hrefs={{ write: writeHref, notes: notesHref, review: reviewHref }}
		/>
		<SidebarSearch bind:query placeholder="Filter characters, places, lore..." />
	</div>
	<div class="left-scroll">
		{#if boardHref}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the path) -->
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
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a
				class="ent-row"
				class:active={character.id === selectedId}
				href={`${planPath}?entity=${character.id}`}
			>
				<EntityBadge
					name={character.name}
					badgeColor={character.badgeColor}
					badgeAssetId={character.badgeAssetId}
					categoryColor={character.color}
				/>
				<span class="name">{character.name}</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
		{#if q === ''}
			<form method="POST" action="?/createCharacter" class="new-entity">
				{#if form?.kind === 'character' && form.message}
					<p class="error" role="alert">{form.message}</p>
				{/if}
				<input type="text" name="name" placeholder="New character name" required />
				<button class="outline-add" type="submit">
					<Icon name="plus" size={13} /> Add character
				</button>
			</form>
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
					<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
					<a
						class="ent-row uni-row"
						class:active={candidate.id === selectedId}
						href={`${planPath}?entity=${candidate.id}`}
					>
						<EntityBadge
							name={candidate.name}
							badgeColor={candidate.badgeColor}
							badgeAssetId={candidate.badgeAssetId}
							categoryColor={candidate.color}
						/>
						<span class="name">{candidate.name}</span>
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/each}
			{/if}
			{#if q === ''}
				<form method="POST" action="?/declareMember" class="new-entity">
					<input type="hidden" name="kind" value="character" />
					<select name="entityId" aria-label="Add an existing character" required>
						<option value="">From the universe...</option>
						{#each availableCharacters as candidate (candidate.id)}
							<option value={candidate.id}>{candidate.name}</option>
						{/each}
					</select>
					<button class="outline-add" type="submit">
						<Icon name="plus" size={13} /> Add to this story
					</button>
				</form>
			{/if}
		{/if}

		<div class="group-label">
			<span class="gl-left">Places</span>
			<span class="count">{visiblePlaces.length}</span>
		</div>
		{#each visiblePlaces as place (place.id)}
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a
				class="ent-row"
				class:active={place.id === selectedId}
				href={`${planPath}?entity=${place.id}`}
			>
				<EntityBadge
					name={place.name}
					badgeColor={place.badgeColor}
					badgeAssetId={place.badgeAssetId}
					categoryColor={place.color}
				/>
				<span class="name">{place.name}</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
		{#if q === ''}
			<form method="POST" action="?/createPlace" class="new-entity">
				{#if form?.kind === 'place' && form.message}
					<p class="error" role="alert">{form.message}</p>
				{/if}
				<input type="text" name="name" placeholder="New place name" required />
				<button class="outline-add" type="submit">
					<Icon name="plus" size={13} /> Add place
				</button>
			</form>
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
					<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
					<a
						class="ent-row uni-row"
						class:active={candidate.id === selectedId}
						href={`${planPath}?entity=${candidate.id}`}
					>
						<EntityBadge
							name={candidate.name}
							badgeColor={candidate.badgeColor}
							badgeAssetId={candidate.badgeAssetId}
							categoryColor={candidate.color}
						/>
						<span class="name">{candidate.name}</span>
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/each}
			{/if}
			{#if q === ''}
				<form method="POST" action="?/declareMember" class="new-entity">
					<input type="hidden" name="kind" value="place" />
					<select name="entityId" aria-label="Add an existing place" required>
						<option value="">From the universe...</option>
						{#each availablePlaces as candidate (candidate.id)}
							<option value={candidate.id}>{candidate.name}</option>
						{/each}
					</select>
					<button class="outline-add" type="submit">
						<Icon name="plus" size={13} /> Add to this story
					</button>
				</form>
			{/if}
		{/if}
		{#if form?.kind === 'member' && form.message}
			<p class="error new-entity" role="alert">{form.message}</p>
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
					<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
					<a
						class="ent-row"
						class:active={entry.id === selectedId}
						href={`${planPath}?entity=${entry.id}`}
					>
						<EntityBadge
							name={entry.name}
							badgeColor={entry.badgeColor}
							badgeAssetId={entry.badgeAssetId}
							categoryColor={category.color}
						/>
						<span class="name">{entry.name}</span>
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/each}
				{#if q === ''}
					<form method="POST" action="?/createLoreEntry" class="new-entity">
						<input type="hidden" name="categoryId" value={category.id} />
						<input type="text" name="name" placeholder="New {category.name} entry" required />
						<button class="outline-add" type="submit">
							<Icon name="plus" size={13} /> Add entry
						</button>
					</form>
				{/if}
			{/if}
		{/each}
		{#if form?.kind === 'lore' && form.message}
			<p class="error new-entity" role="alert">{form.message}</p>
		{/if}

		{#if !anyMatch}
			<div class="search-empty">Nothing matches.</div>
		{/if}
		{#if q === ''}
			<form method="POST" action="?/createCategory" class="new-entity">
				{#if form?.kind === 'category' && form.message}
					<p class="error" role="alert">{form.message}</p>
				{/if}
				<input type="text" name="name" placeholder="New category name" required />
				<select name="color">
					<option value="">No colour</option>
					{#each CATEGORY_COLORS as choice (choice.token)}
						<option value={choice.token}>{choice.label}</option>
					{/each}
				</select>
				<button class="outline-add" type="submit">
					<Icon name="plus" size={13} /> Add category
				</button>
			</form>
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
	.new-entity input,
	.new-entity select {
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		color: var(--text);
		font-size: 13px;
		padding: 7px 9px;
		outline: none;
	}
	.new-entity input:focus {
		border-color: var(--accent-line);
	}
	.new-entity input::placeholder {
		color: var(--text-faint);
	}
	.error {
		color: var(--danger, #b00020);
		font-size: 12.5px;
		margin: 0;
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
