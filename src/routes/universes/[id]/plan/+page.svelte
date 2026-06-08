<script lang="ts">
	import { resolve } from '$app/paths';
	import EntityEditor from '$lib/components/EntityEditor.svelte';
	import PlanSidebar from '$lib/components/PlanSidebar.svelte';
	import SessionPanel from '$lib/components/SessionPanel.svelte';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import StoryBoard from '$lib/components/StoryBoard.svelte';
	import type { SaveStatus } from '$lib/components/SceneEditor.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saveStatus = $state<SaveStatus>('idle');
	// The board's new-story form swaps in when the button is clicked; a
	// failed submit reloads the page, so reopen it to show the message.
	let creatingStory = $state(false);
	$effect(() => {
		if (form?.scope === 'story' && form.message) creatingStory = true;
	});
	const selectedId = $derived(data.selected?.id);
	$effect(() => {
		void selectedId;
		saveStatus = 'idle';
	});

	const planPath = $derived(resolve('/universes/[id]/plan', { id: data.universe.slug }));

	// Right column tabs; History holds the open entity's timeline.
	let rightTab = $state<'reference' | 'history' | 'session'>('reference');
	const itemHref = $derived(data.selected ? `${planPath}?entity=${data.selected.id}` : planPath);

	// Appearances arrive flat and ordered; the panel shows them story by
	// story, scene by scene.
	const storiesSeen = $derived([...new Map(data.appearsIn.map((m) => [m.storyId, m])).values()]);
</script>

<svelte:head>
	<title>{data.universe.name} - Plan - Codex</title>
</svelte:head>

<!-- The new-story affordance shown above the board and in the empty states. -->
{#snippet newStory()}
	{#if creatingStory}
		<form method="POST" action="?/createStory" class="new-story-form">
			<!-- svelte-ignore a11y_autofocus (swaps in on the button click; focus follows the action) -->
			<input
				class="input"
				type="text"
				name="title"
				placeholder="Story title"
				required
				autofocus
				onkeydown={(e) => {
					if (e.key === 'Escape') creatingStory = false;
				}}
			/>
			<button class="btn btn-primary" type="submit">Create</button>
			<button class="btn btn-ghost" type="button" onclick={() => (creatingStory = false)}>
				Cancel
			</button>
		</form>
		{#if form?.scope === 'story' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
	{:else}
		<button class="btn btn-secondary" type="button" onclick={() => (creatingStory = true)}>
			New story
		</button>
	{/if}
{/snippet}

<div class="app">
	<TopBar
		universe={{ slug: data.universe.slug, name: data.universe.name }}
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
			notesHref={resolve('/universes/[id]/notes', { id: data.universe.slug })}
			boardHref={planPath}
			boardActive={!data.selected}
			boardLabel="Story board"
			{form}
		/>
		<main class="pane center">
			{#if data.selected && data.revisionPreview && data.revisionTarget}
				<div class="detail">
					<RevisionPreview
						revision={data.revisionPreview}
						currentBody={data.selected.bodyMd}
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
							character: data.characters,
							place: data.places,
							lore_entry: data.lore
						}}
						entityHref={(id) => `${planPath}?entity=${id}`}
						universeRef={data.universe.slug}
						onStatus={(status) => (saveStatus = status)}
					/>
				{/key}
			{:else if data.storyBoard.length > 0}
				<!-- Nothing selected: the universe's stories as a board, each in
				     the lane of its derived status. -->
				<div class="board-tools">
					{@render newStory()}
				</div>
				<StoryBoard
					stories={data.storyBoard.map((story) => ({
						...story,
						href: resolve('/stories/[id]', { id: story.slug })
					}))}
				/>
			{:else if data.characters.length === 0 && data.places.length === 0}
				<div class="empty">
					<p>Nothing here yet. Start a story, or add a character or a place in the sidebar.</p>
					{@render newStory()}
				</div>
			{:else}
				<div class="empty">
					<p>Select a character or place in the sidebar, or start a story.</p>
					{@render newStory()}
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
				<SessionPanel universeSlug={data.universe.slug} />
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
									{#each mentions as mention, mi (mi)}
										<a
											class="snippet"
											href={`${resolve('/stories/[id]', { id: storyRef.storyId })}?scene=${sceneRef.sceneId}&at=${mention.position}`}
										>
											{mention.snippet}
										</a>
									{/each}
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
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
	.board-tools {
		display: flex;
		justify-content: flex-end;
		padding: 14px 18px 0;
	}
	.new-story-form {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.empty .new-story-form,
	.empty .btn {
		margin-top: 12px;
	}
	.rel-label {
		color: var(--text-muted);
		font-size: 12px;
		margin-right: 6px;
	}
	/* A snippet links to its spot in the scene. */
	.snippet {
		display: block;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.5;
		padding: 2px 0 6px;
		border-bottom: 1px dashed var(--border);
		text-decoration: none;
	}
	.snippet:hover {
		color: var(--text);
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
