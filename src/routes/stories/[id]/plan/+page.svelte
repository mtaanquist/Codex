<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EntityEditor from '$lib/components/EntityEditor.svelte';
	import SceneBoard from '$lib/components/SceneBoard.svelte';
	import PlanSidebar from '$lib/components/PlanSidebar.svelte';
	import SessionPanel from '$lib/components/SessionPanel.svelte';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
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

	const planPath = $derived(resolve('/stories/[id]/plan', { id: data.story.slug }));

	// Right column tabs; History holds the open item's timeline.
	let rightTab = $state<'reference' | 'history' | 'session'>('reference');
	const itemHref = $derived(data.selected ? `${planPath}?entity=${data.selected.id}` : planPath);
	const currentBody = $derived(data.selected?.bodyMd ?? '');
</script>

<svelte:head>
	<title>{data.story.title} - Plan - Codex</title>
</svelte:head>

<div class="app">
	<TopBar
		universe={{ slug: data.universe.slug, name: data.universe.name }}
		story={{ slug: data.story.slug, title: data.story.title }}
		{saveStatus}
		help={{ topic: 'planning', label: 'the planning view' }}
	/>
	<div class="body">
		<PlanSidebar
			characters={data.characters}
			places={data.places}
			categories={data.categories}
			lore={data.lore}
			{selectedId}
			{planPath}
			writeHref={resolve('/stories/[id]', { id: data.story.slug })}
			boardHref={planPath}
			boardActive={!data.selected}
			{form}
			availableCharacters={data.availableCharacters}
			availablePlaces={data.availablePlaces}
		/>
		<main class="pane center">
			{#if data.revisionPreview && data.revisionTarget}
				<div class="detail">
					<RevisionPreview
						revision={data.revisionPreview}
						{currentBody}
						entityType={data.revisionTarget.type}
						entityId={data.revisionTarget.id}
						exitHref={itemHref}
					/>
				</div>
			{:else if data.selected}
				{#key data.selected.id}
					<EntityEditor
						kind={data.selectedKind}
						entity={data.selected}
						categories={data.categories}
						relationTypes={data.relationTypes}
						relationships={data.relationships}
						targets={{
							character: data.universeCharacters,
							place: data.universePlaces,
							lore_entry: data.lore
						}}
						storyId={data.story.id}
						storyNotesMd={data.storyNotesMd}
						membership={data.membership}
						entityHref={(id) => `${planPath}?entity=${id}`}
						onStatus={(status) => (saveStatus = status)}
					/>
				{/key}
			{:else if data.scenes.length > 0}
				<!-- With nothing selected, the centre is the scene board. -->
				<SceneBoard
					scenes={data.scenes}
					chapters={data.chapters}
					todoCounts={data.todoCounts}
					sceneHref={(sceneId) =>
						`${resolve('/stories/[id]', { id: data.story.slug })}?scene=${sceneId}`}
					onMove={async (sceneId, status) => {
						await fetch(`/api/scenes/${sceneId}`, {
							method: 'PATCH',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ status })
						});
						await invalidateAll();
					}}
				/>
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
			<div class="right-head">
				<!-- The same three pills whether the centre shows the board or an
				     entity, so the pane never changes shape underfoot. -->
				<div class="rtabs">
					<button
						class="rtab"
						class:active={rightTab === 'reference'}
						type="button"
						onclick={() => (rightTab = 'reference')}
					>
						Reference
					</button>
					<button
						class="rtab"
						class:active={rightTab === 'history'}
						type="button"
						onclick={() => (rightTab = 'history')}
					>
						History
					</button>
					<button
						class="rtab"
						class:active={rightTab === 'session'}
						type="button"
						onclick={() => (rightTab = 'session')}
					>
						Session
					</button>
				</div>
			</div>
			{#if rightTab === 'session'}
				<SessionPanel universeSlug={data.universe.slug} storyId={data.story.id} />
			{:else if rightTab === 'history'}
				{#if data.revisionTarget}
					<RevisionHistory
						entityType={data.revisionTarget.type}
						entityId={data.revisionTarget.id}
						revisions={data.revisionRows}
						previewId={data.revisionPreview?.id}
						previewHref={(revisionId) => `${itemHref}&revision=${revisionId}`}
					/>
				{:else}
					<div class="right-scroll">
						<div class="empty">Select a character or place to see its history.</div>
					</div>
				{/if}
			{:else}
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
						{@const scenesSeen = [...new Map(data.appearsIn.map((m) => [m.sceneId, m])).values()]}
						<div class="r-card">
							<h5>Appears in</h5>
							{#each scenesSeen as sceneRef (sceneRef.sceneId)}
								{@const mentions = data.appearsIn.filter((m) => m.sceneId === sceneRef.sceneId)}
								<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
								<a
									class="r-line"
									href={`${resolve('/stories/[id]', { id: data.story.slug })}?scene=${sceneRef.sceneId}`}
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
					{#if data.selected}
						<div class="r-card mentions-card">
							<span>All mentions</span>
							<span class="r-count">{data.mentionTotal}</span>
						</div>
					{/if}
				</div>
			{/if}
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
	.mentions-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.mentions-card span:first-child {
		font-size: 13.5px;
		font-weight: 600;
	}
</style>
