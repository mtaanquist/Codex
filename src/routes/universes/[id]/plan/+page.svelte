<script lang="ts">
	import { resolve } from '$app/paths';
	import EntityEditor from '$lib/components/EntityEditor.svelte';
	import PlanSidebar from '$lib/components/PlanSidebar.svelte';
	import type { SaveStatus } from '$lib/components/SceneEditor.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saveStatus = $state<SaveStatus>('idle');
	const selectedId = $derived(data.selected?.id);
	$effect(() => {
		void selectedId;
		saveStatus = 'idle';
	});

	const planPath = $derived(resolve('/universes/[id]/plan', { id: data.universe.id }));

	// Appearances arrive flat and ordered; the panel shows them story by
	// story, scene by scene.
	const storiesSeen = $derived([...new Map(data.appearsIn.map((m) => [m.storyId, m])).values()]);

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
	<title>{data.universe.name} - Plan - Codex</title>
</svelte:head>

<div class="app">
	<TopBar universe={{ id: data.universe.id, name: data.universe.name }} {initials} {saveStatus} />
	<div class="body">
		<PlanSidebar
			characters={data.characters}
			places={data.places}
			categories={data.categories}
			lore={data.lore}
			{selectedId}
			{planPath}
			{form}
		/>
		<main class="pane center">
			{#if data.selected}
				{#key data.selected.id}
					<EntityEditor
						kind={data.selectedKind}
						entity={data.selected}
						categories={data.categories}
						relationTypes={data.relationTypes}
						relationships={data.relationships}
						targets={{
							character: data.characters,
							place: data.places,
							lore_entry: data.lore
						}}
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
				{#if data.selected && data.relationships.length > 0}
					<div class="r-card">
						<h5>Relationships</h5>
						{#each data.relationships as relationship (relationship.id)}
							<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
							<a class="r-line" href={`${planPath}?entity=${relationship.otherId}`}>
								<span class="r-line-left">
									<span class="rel-label">{relationship.label}</span>
									<span class="r-line-name">{relationship.otherName}</span>
								</span>
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/each}
					</div>
				{/if}
				{#if data.selected && data.appearsIn.length > 0}
					{#each storiesSeen as storyRef (storyRef.storyId)}
						{@const inStory = data.appearsIn.filter((m) => m.storyId === storyRef.storyId)}
						{@const scenesSeen = [...new Map(inStory.map((m) => [m.sceneId, m])).values()]}
						<div class="r-card">
							<h5>Appears in {storyRef.storyTitle}</h5>
							{#each scenesSeen as sceneRef (sceneRef.sceneId)}
								{@const mentions = inStory.filter((m) => m.sceneId === sceneRef.sceneId)}
								<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
								<a
									class="r-line"
									href={`${resolve('/stories/[id]', { id: storyRef.storyId })}?scene=${sceneRef.sceneId}`}
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
					{/each}
				{:else if data.selected}
					<div class="empty">
						No mentions yet. Mentions appear shortly after the prose is saved.
					</div>
				{:else}
					<div class="empty">Mentions and relationships arrive here.</div>
				{/if}
			</div>
		</aside>
	</div>
</div>

<style>
	.r-line {
		text-decoration: none;
	}
	.rel-label {
		color: var(--text-muted);
		font-size: 12px;
		margin-right: 6px;
	}
	.snippet {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.5;
		padding: 2px 0 6px;
		border-bottom: 1px dashed var(--border);
	}
</style>
