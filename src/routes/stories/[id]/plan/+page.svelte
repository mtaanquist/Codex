<script lang="ts">
	import { resolve } from '$app/paths';
	import EntityEditor from '$lib/components/EntityEditor.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { SaveStatus } from '$lib/components/SceneEditor.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import { entityColor, entityLetter } from '$lib/entity-color';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saveStatus = $state<SaveStatus>('idle');
	const selectedId = $derived(data.selected?.id);
	$effect(() => {
		void selectedId;
		saveStatus = 'idle';
	});

	const planPath = $derived(resolve('/stories/[id]/plan', { id: data.story.id }));

	const initials = $derived(
		data.user.displayName
			.split(/\s+/)
			.map((part) => part[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);
</script>

<svelte:head>
	<title>{data.story.title} - Plan - Codex</title>
</svelte:head>

<div class="app">
	<TopBar
		universe={{ id: data.universe.id, name: data.universe.name }}
		story={{ id: data.story.id, title: data.story.title }}
		{initials}
		{saveStatus}
	/>
	<div class="body">
		<aside class="pane left">
			<div class="left-head">
				<div class="seg full">
					<a class="seg-btn" href={resolve('/stories/[id]', { id: data.story.id })}>Write</a>
					<button class="seg-btn active" type="button">Plan</button>
					<button class="seg-btn" type="button" disabled>Notes</button>
				</div>
			</div>
			<div class="left-scroll">
				<div class="group-label">
					<span class="gl-left">Characters</span>
					<span class="count">{data.characters.length}</span>
				</div>
				{#each data.characters as character (character.id)}
					<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
					<a
						class="ent-row"
						class:active={character.id === data.selected?.id}
						href={`${planPath}?entity=${character.id}`}
					>
						<span class="badge dot" style="background: {entityColor(character.name)}">
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

				<div class="group-label">
					<span class="gl-left">Places</span>
					<span class="count">{data.places.length}</span>
				</div>
				{#each data.places as place (place.id)}
					<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
					<a
						class="ent-row"
						class:active={place.id === data.selected?.id}
						href={`${planPath}?entity=${place.id}`}
					>
						<span class="badge dot" style="background: {entityColor(place.name)}">
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
			</div>
		</aside>
		<main class="pane center">
			{#if data.selected}
				{#key data.selected.id}
					<EntityEditor
						kind={data.selectedKind}
						entity={data.selected}
						storyId={data.story.id}
						storyNotesMd={data.storyNotesMd}
						onStatus={(status) => (saveStatus = status)}
					/>
				{/key}
			{:else if data.characters.length === 0 && data.places.length === 0}
				<div class="empty">
					<p>Nothing here yet. Add a character or a place in the sidebar.</p>
				</div>
			{:else}
				<div class="empty">
					<p>Select a character or place in the sidebar.</p>
				</div>
			{/if}
		</main>
		<aside class="pane right">
			<div class="right-scroll">
				{#if data.selected && data.appearsIn.length > 0}
					{@const scenesSeen = [...new Map(data.appearsIn.map((m) => [m.sceneId, m])).values()]}
					<div class="r-card">
						<h5>Appears in</h5>
						{#each scenesSeen as sceneRef (sceneRef.sceneId)}
							{@const mentions = data.appearsIn.filter((m) => m.sceneId === sceneRef.sceneId)}
							<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
							<a
								class="r-line"
								href={`${resolve('/stories/[id]', { id: data.story.id })}?scene=${sceneRef.sceneId}`}
							>
								<span class="r-line-left">
									<span class="r-line-name">{sceneRef.sceneTitle ?? 'Untitled scene'}</span>
								</span>
								<span class="r-count">{mentions.length}</span>
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{#each mentions as mention, mi (mi)}
								<div class="snippet">{mention.snippet}</div>
							{/each}
						{/each}
					</div>
				{:else if data.selected}
					<div class="empty">
						No mentions in this story yet. Mentions appear shortly after the prose is saved.
					</div>
				{:else}
					<div class="empty">Mentions and relationships arrive here.</div>
				{/if}
			</div>
		</aside>
	</div>
</div>

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
	.new-entity input {
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
	.r-line {
		text-decoration: none;
	}
	.snippet {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.5;
		padding: 2px 0 6px;
		border-bottom: 1px dashed var(--border);
	}
</style>
