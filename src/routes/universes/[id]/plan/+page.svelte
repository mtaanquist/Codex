<script lang="ts">
	import { resolve } from '$app/paths';
	import EntityEditor from '$lib/components/EntityEditor.svelte';
	import PlanSidebar from '$lib/components/PlanSidebar.svelte';
	import PanelStrip from '$lib/components/PanelStrip.svelte';
	import { activePanel, visiblePanels, type PanelId } from '$lib/panels';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import StoryBoard from '$lib/components/StoryBoard.svelte';
	import AssistantPanel from '$lib/components/AssistantPanel.svelte';
	import type { SaveStatus } from '$lib/components/SceneEditor.svelte';
	import AppBar from '$lib/components/AppBar.svelte';
	import { UNIVERSE_MODE_NOTE, universePath } from '$lib/chrome';
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

	// Grounded starter prompts for the Assistant tab, leaning on its cross-story
	// reach across the universe.
	const assistantSuggestions = $derived.by(() => {
		const characters = data.characters.map((c) => c.name);
		const prompts: string[] = [];
		if (characters[0]) prompts.push(`What happens to ${characters[0]} across the stories?`);
		prompts.push('Check continuity across the stories in this universe.');
		if (characters[0] && characters[1]) {
			prompts.push(`How are ${characters[0]} and ${characters[1]} connected?`);
		} else {
			prompts.push('Give me a tour of this universe.');
		}
		return prompts;
	});

	// The right pane's panels: every one of them is about the open entry, so
	// with nothing selected the pane closes rather than standing empty.
	const panels = $derived(
		visiblePanels({
			reference: Boolean(data.selected),
			assistant: data.selected ? data.assistant.tabEnabled : false,
			history: Boolean(data.selected),
			notes: data.selected ? data.universeNotes.length : false
		})
	);
	const universeNotesPath = $derived(resolve('/universes/[id]/notes', { id: data.universe.slug }));
	let chosenPanel = $state<PanelId | null>('reference');
	const rightTab = $derived(activePanel(panels, chosenPanel));
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
		<div class="new-story-actions">
			<button class="btn btn-secondary" type="button" onclick={() => (creatingStory = true)}>
				New story
			</button>
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolve() plus a static hash) -->
			<a
				class="btn btn-ghost"
				href={`${resolve('/universes/[id]/[[section]]', { id: data.universe.slug, section: 'export' })}#import-story`}
			>
				Import story
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
	{/if}
{/snippet}

<div class="app">
	<AppBar
		crumbs={universePath(data.universe, { universeAt: 'universe' })}
		{saveStatus}
		helpTopic="planning"
		helpLabel="the planning view"
	/>
	<div class="body" class:no-right={panels.length === 0}>
		<PlanSidebar
			characters={data.characters}
			places={data.places}
			categories={data.categories}
			lore={data.lore}
			{selectedId}
			{planPath}
			writeHref={planPath}
			reviewHref={planPath}
			modeNote={UNIVERSE_MODE_NOTE}
			insightsHref={resolve('/universes/[id]/insights', { id: data.universe.slug })}
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
						assetsConfigured={data.assetsConfigured}
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
				<div class="empty-state">
					<p class="empty-state-text">
						Nothing here yet. Start a story, or add a character or a place in the sidebar.
					</p>
					<div class="empty-state-action">{@render newStory()}</div>
				</div>
			{:else}
				<div class="empty-state">
					<p class="empty-state-text">
						Select a character or place in the sidebar, or start a story.
					</p>
					<div class="empty-state-action">{@render newStory()}</div>
				</div>
			{/if}
		</main>
		{#if rightTab}
			<aside class="pane right">
				<PanelStrip
					{panels}
					active={rightTab}
					onSelect={(id) => (chosenPanel = id)}
					label="Panels about this entry"
				>
					{#snippet panel(id)}
						{#if id === 'assistant'}
							<AssistantPanel
								scope={{ universeId: data.universe.id, universeName: data.universe.name }}
								name={data.assistant.name}
								suggestions={assistantSuggestions}
								initialMessages={data.assistantChat}
							/>
						{:else if id === 'history'}
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
									<div class="empty-state tight">
										<p class="empty-state-text">No versions of this entry yet.</p>
									</div>
								</div>
							{/if}
						{:else if id === 'notes'}
							<div class="right-scroll">
								{#if data.universeNotes.length > 0}
									<div class="r-card">
										<h5>In this universe</h5>
										{#each data.universeNotes as note (note.id)}
											<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
											<a class="r-line" href={`${universeNotesPath}?note=${note.id}`}>
												<span class="r-line-left">
													<span class="r-line-name">{note.title ?? 'Untitled note'}</span>
												</span>
											</a>
											<!-- eslint-enable svelte/no-navigation-without-resolve -->
										{/each}
									</div>
								{:else}
									<div class="empty-state tight">
										<p class="empty-state-text">No notes in this universe yet.</p>
									</div>
								{/if}
								<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path) -->
								<form method="POST" action="{universeNotesPath}?/createNote">
									<button class="btn btn-sm btn-secondary" type="submit">New note</button>
								</form>
								<a class="btn btn-sm btn-ghost" href={universeNotesPath}>All notes</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</div>
							<p class="panel-note">
								The universe's notes, shared by every story in it. Open one, or All notes, to read
								and edit on the Notes page.
							</p>
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
														<span class="r-line-name">
															{sceneRef.sceneTitle ?? 'Untitled scene'}
														</span>
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
									<div class="empty-state tight">
										<p class="empty-state-text">
											No mentions yet. Mentions appear shortly after the prose is saved.
										</p>
									</div>
								{/if}
								{#if data.selected}
									<div class="r-card mentions-card">
										<span>All mentions</span>
										<span class="r-count">{data.mentionTotal}</span>
									</div>
								{/if}
							</div>
							<p class="panel-note">
								Where this entry turns up in the prose of every story here, and who it is connected
								to.
							</p>
						{/if}
					{/snippet}
				</PanelStrip>
			</aside>
		{/if}
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
	.new-story-actions {
		display: inline-flex;
		gap: 8px;
		align-items: center;
	}
	.empty-state .new-story-form,
	.empty-state .btn {
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
