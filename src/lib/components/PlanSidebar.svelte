<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import { entityColor, entityLetter } from '$lib/entity-color';

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
		form,
		before,
		availableCharacters = [],
		availablePlaces = []
	}: {
		characters: { id: string; name: string; color: string | null }[];
		places: { id: string; name: string; color: string | null }[];
		categories: { id: string; name: string; color: string | null }[];
		lore: { id: string; name: string; categoryId: string }[];
		selectedId?: string;
		planPath: string;
		// Present at story scope only; the universe Plan has no Write view.
		writeHref?: string;
		form: { kind?: string; message?: string } | null;
		// Rendered above the entity groups; the story Plan puts its outline here.
		before?: Snippet;
		// Universe entities not in the story yet; picking one declares it a
		// member. Story scope only.
		availableCharacters?: { id: string; name: string }[];
		availablePlaces?: { id: string; name: string }[];
	} = $props();
</script>

<aside class="pane left">
	<div class="left-head">
		<div class="seg full">
			{#if writeHref}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the path) -->
				<a class="seg-btn" href={writeHref}>Write</a>
			{/if}
			<button class="seg-btn active" type="button">Plan</button>
			<button class="seg-btn" type="button" disabled>Notes</button>
		</div>
	</div>
	<div class="left-scroll">
		{#if before}
			{@render before()}
		{/if}
		<div class="group-label">
			<span class="gl-left">Characters</span>
			<span class="count">{characters.length}</span>
		</div>
		{#each characters as character (character.id)}
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a
				class="ent-row"
				class:active={character.id === selectedId}
				href={`${planPath}?entity=${character.id}`}
			>
				<span
					class="badge dot"
					style="background: {character.color ?? entityColor(character.name)}"
				>
					{entityLetter(character.name)}
				</span>
				<span class="name">{character.name}</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
		<form method="POST" action="?/createCharacter" class="new-entity">
			{#if form?.kind === 'character' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			<input type="text" name="name" placeholder="New character name" required />
			<button class="outline-add" type="submit">
				<Icon name="plus" size={13} /> Add character
			</button>
		</form>
		{#if availableCharacters.length > 0}
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

		<div class="group-label">
			<span class="gl-left">Places</span>
			<span class="count">{places.length}</span>
		</div>
		{#each places as place (place.id)}
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a
				class="ent-row"
				class:active={place.id === selectedId}
				href={`${planPath}?entity=${place.id}`}
			>
				<span class="badge dot" style="background: {place.color ?? entityColor(place.name)}">
					{entityLetter(place.name)}
				</span>
				<span class="name">{place.name}</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
		<form method="POST" action="?/createPlace" class="new-entity">
			{#if form?.kind === 'place' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			<input type="text" name="name" placeholder="New place name" required />
			<button class="outline-add" type="submit">
				<Icon name="plus" size={13} /> Add place
			</button>
		</form>
		{#if availablePlaces.length > 0}
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
		{#if form?.kind === 'member' && form.message}
			<p class="error new-entity" role="alert">{form.message}</p>
		{/if}

		{#each categories as category (category.id)}
			{@const entries = lore.filter((entry) => entry.categoryId === category.id)}
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
					<span class="badge dot" style="background: {category.color ?? entityColor(entry.name)}">
						{entityLetter(entry.name)}
					</span>
					<span class="name">{entry.name}</span>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
			<form method="POST" action="?/createLoreEntry" class="new-entity">
				<input type="hidden" name="categoryId" value={category.id} />
				<input type="text" name="name" placeholder="New {category.name} entry" required />
				<button class="outline-add" type="submit">
					<Icon name="plus" size={13} /> Add entry
				</button>
			</form>
		{/each}
		{#if form?.kind === 'lore' && form.message}
			<p class="error new-entity" role="alert">{form.message}</p>
		{/if}

		<form method="POST" action="?/createCategory" class="new-entity">
			{#if form?.kind === 'category' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			<input type="text" name="name" placeholder="New category name" required />
			<select name="color">
				<option value="">No colour</option>
				<option value="var(--cat-blue)">Blue</option>
				<option value="var(--cat-violet)">Violet</option>
				<option value="var(--cat-rose)">Rose</option>
				<option value="var(--cat-green)">Green</option>
				<option value="var(--cat-amber)">Amber</option>
			</select>
			<button class="outline-add" type="submit">
				<Icon name="plus" size={13} /> Add category
			</button>
		</form>
	</div>
</aside>

<style>
	.seg-btn {
		text-decoration: none;
		text-align: center;
	}
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
	.cat-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 99px;
		margin-right: 6px;
	}
</style>
