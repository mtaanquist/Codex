<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import Landing from '$lib/components/Landing.svelte';
	import NewMenu from '$lib/components/NewMenu.svelte';
	import AppBar from '$lib/components/AppBar.svelte';
	import { libraryCrumb } from '$lib/chrome';
	import { formatNumber } from '$lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Every collection makes new things from its own header, with the same menu
	// shape: make, then import. Picking a make row swaps in that collection's
	// inline title form. The standalone section uses the 'standalone' sentinel,
	// since that universe may not exist yet.
	let creatingUniverse = $state(false);
	let newStoryFor = $state<string | null>(null);

	// A failed submit reloads the page; reopen the form it came from.
	$effect(() => {
		if (form?.scope === 'universe' && form.message) creatingUniverse = true;
		if (form?.scope === 'standalone' && form.message) newStoryFor = 'standalone';
		if (form?.scope === 'story' && form.message) newStoryFor = form.universeId ?? null;
	});

	type Story = (typeof data.stories)[number];

	const recent = $derived(
		[...data.stories]
			.sort((a, b) => new Date(b.editedAt).getTime() - new Date(a.editedAt).getTime())
			.slice(0, 3)
	);

	const totalWords = $derived(data.stories.reduce((sum, story) => sum + story.words, 0));

	function count(n: number, noun: string, plural = `${noun}s`) {
		return `${formatNumber(n)} ${n === 1 ? noun : plural}`;
	}

	function universeStories(universeId: string) {
		return data.stories.filter((story) => story.universeId === universeId);
	}

	// Stories that do not belong to a world file under one "Standalone
	// stories" universe, created on first use. Until then the section is
	// rendered from nothing so the create card always has a home, and once
	// it exists it stays pinned after the real universes.
	const hasStandalone = $derived(data.universes.some((u) => u.standalone));
	const standaloneUniverse = $derived(data.universes.find((u) => u.standalone));
	const orderedUniverses = $derived(
		[...data.universes].sort((a, b) => Number(a.standalone) - Number(b.standalone))
	);

	// Importing lands a story in a universe, so the link carries one: the
	// standalone home when there is one, otherwise the first universe. With no
	// universes at all there is nowhere to import into yet, and the row is left
	// out rather than pointing at a page that cannot exist.
	function importHref(slug: string): string {
		return `${resolve('/universes/[id]/[[section]]', { id: slug, section: 'export' })}#import-story`;
	}
	const libraryImportTarget = $derived(standaloneUniverse ?? data.universes[0]);

	// "New standalone story" from anywhere: the standalone home's own form when
	// it exists, otherwise the form that creates the home on first use.
	function startStandaloneStory() {
		newStoryFor = standaloneUniverse?.id ?? 'standalone';
	}

	const IMPORT_NOTE =
		"Import reads a Codex export, a Word document (.docx) and an EPUB; the document's headings become your chapters. A universe holds stories that share a world, cast and notes.";
	const UNIVERSE_STORY_NOTE = 'A story in a universe shares its cast, places and notes.';
	const STANDALONE_NOTE = 'A standalone story keeps its own cast and notes.';
</script>

<svelte:head>
	<title>{data.user ? 'Library - Codex' : 'Codex - A writing tool'}</title>
</svelte:head>

{#if !data.user}
	<Landing signupOpen={data.signupOpen ?? true} />
{:else}
	{@render library()}
{/if}

{#snippet storyCard(story: Story)}
	<a class="story-card" href={resolve('/stories/[id]', { id: story.slug })}>
		<div class="story-card-header">
			<h3 class="story-card-title" class:story-card-empty={story.words === 0}>{story.title}</h3>
			<span class="story-card-status">
				<span class="scene-dot" style="background: var(--status-{story.status.token});"></span>
				{story.status.label}
			</span>
		</div>
		{#if story.brief}<p class="story-card-brief">{story.brief}</p>{/if}
		<div class="story-card-meta">
			<span>{count(story.chapters, 'chapter')}</span>
			<span class="story-card-meta-sep">·</span>
			<span>{count(story.words, 'word')}</span>
			<span class="story-card-meta-sep">·</span>
			<span>edited {story.editedLabel}</span>
		</div>
	</a>
{/snippet}

{#snippet library()}
	<div class="page-shell">
		<AppBar crumbs={[libraryCrumb(true)]} helpTopic="getting-started" helpLabel="the library" />

		<div class="page-body">
			<div class="page-container">
				<div class="page-header">
					<div>
						<h1 class="page-title">Your library</h1>
						<p class="page-subtitle">
							{count(data.universes.length, 'universe')} · {count(
								data.stories.length,
								'story',
								'stories'
							)} · {formatNumber(totalWords)} words in total
						</p>
					</div>
					<div class="page-actions">
						{#if creatingUniverse}
							<form class="new-inline" method="POST" action="?/createUniverse">
								<!-- svelte-ignore a11y_autofocus (the field only appears on the menu choice) -->
								<input
									class="input"
									type="text"
									name="name"
									aria-label="New universe"
									placeholder="Universe name"
									required
									autofocus
									onkeydown={(e) => {
										if (e.key === 'Escape') creatingUniverse = false;
									}}
								/>
								<button class="btn btn-primary" type="submit">Create universe</button>
								<button
									class="btn btn-ghost"
									type="button"
									onclick={() => (creatingUniverse = false)}
								>
									Cancel
								</button>
							</form>
						{:else}
							<NewMenu
								label="New"
								variant="primary"
								size="md"
								items={[
									{ label: 'New universe', onSelect: () => (creatingUniverse = true) },
									{ label: 'New standalone story', onSelect: startStandaloneStory }
								]}
								importItem={libraryImportTarget
									? {
											label: 'Import a story from a file...',
											href: importHref(libraryImportTarget.slug)
										}
									: undefined}
								note={IMPORT_NOTE}
							/>
						{/if}
					</div>
				</div>
				{#if form?.scope === 'universe' && form.message}
					<p class="form-error" role="alert">{form.message}</p>
				{/if}

				{#if data.universes.length === 0}
					<section class="universe-section">
						<p class="universe-description">
							No universes yet. A universe holds the worldbuilding your stories share; create one to
							start writing.
						</p>
					</section>
				{/if}

				{#if recent.length > 0}
					<section class="universe-section">
						<h2 class="universe-mark recent-mark">Recent</h2>
						<div class="recent-row">
							{#each recent as story (story.id)}
								{@render storyCard(story)}
							{/each}
						</div>
					</section>
				{/if}

				{#each orderedUniverses as universe (universe.id)}
					<section class="universe-section">
						<header class="universe-header">
							<span class="universe-mark universe-mark-icon" title="Universe"
								><Icon name="universe" size={18} /></span
							>
							<div class="universe-identity">
								<div class="universe-name-row">
									<a
										class="universe-name-link"
										href={resolve('/universes/[id]/plan', { id: universe.slug })}
									>
										<h2 class="universe-name">{universe.name}</h2>
									</a>
								</div>
								{#if universe.descriptionMd}
									<p class="universe-description">{universe.descriptionMd}</p>
								{/if}
							</div>
							<div class="universe-actions row-actions">
								{#if !universe.standalone}
									<a
										class="btn btn-sm btn-ghost"
										href={resolve('/universes/[id]/insights', { id: universe.slug })}
										aria-label="Insights for {universe.name}"
									>
										Insights
									</a>
								{/if}
								<a
									class="btn btn-sm btn-ghost"
									href={resolve('/universes/[id]/[[section]]', { id: universe.slug })}
									aria-label="Settings for {universe.name}"
								>
									Settings
								</a>
								<NewMenu
									label="New story"
									items={[
										universe.standalone
											? { label: 'New standalone story', onSelect: startStandaloneStory }
											: {
													label: `New story in ${universe.name}`,
													onSelect: () => (newStoryFor = universe.id)
												}
									]}
									importItem={{
										label: universe.standalone
											? 'Import a story from a file...'
											: 'Import a story into this universe...',
										href: importHref(universe.slug)
									}}
									note={universe.standalone ? STANDALONE_NOTE : UNIVERSE_STORY_NOTE}
								/>
							</div>
						</header>
						<div class="story-grid">
							{#each universeStories(universe.id) as story (story.id)}
								{@render storyCard(story)}
							{/each}
							{#if newStoryFor === universe.id}
								<form class="card-add card-add-form" method="POST" action="?/createStory">
									<input type="hidden" name="universeId" value={universe.id} />
									{#if form?.scope === 'story' && form.universeId === universe.id && form.message}
										<p class="form-error" role="alert">{form.message}</p>
									{/if}
									<!-- svelte-ignore a11y_autofocus (the field only appears on the card click) -->
									<input
										class="input"
										type="text"
										name="title"
										aria-label="New story"
										placeholder="Story title"
										required
										autofocus
										onkeydown={(e) => {
											if (e.key === 'Escape') newStoryFor = null;
										}}
									/>
									<div class="card-add-actions">
										<button class="btn btn-primary btn-sm" type="submit">Create story</button>
										<button
											class="btn btn-ghost btn-sm"
											type="button"
											onclick={() => (newStoryFor = null)}
										>
											Cancel
										</button>
									</div>
								</form>
							{:else if universeStories(universe.id).length === 0}
								<!-- The one variant: an empty collection repeats its header's
								     menu in the space the stories would fill. -->
								<div class="collection-empty">
									<p class="collection-empty-text">
										{universe.standalone
											? 'No standalone stories yet. A story that does not share a world lives here.'
											: 'No stories in this universe yet. The world you have built here - its cast, places and notes - is waiting for one.'}
									</p>
									<NewMenu
										label={universe.standalone
											? 'New standalone story'
											: `New story in ${universe.name}`}
										variant="primary"
										size="md"
										align="start"
										items={[
											universe.standalone
												? { label: 'New standalone story', onSelect: startStandaloneStory }
												: {
														label: `New story in ${universe.name}`,
														onSelect: () => (newStoryFor = universe.id)
													}
										]}
										importItem={{
											label: universe.standalone
												? 'Import a story from a file...'
												: 'Import a story into this universe...',
											href: importHref(universe.slug)
										}}
										note={universe.standalone ? STANDALONE_NOTE : UNIVERSE_STORY_NOTE}
									/>
								</div>
							{/if}
						</div>
					</section>
				{/each}

				{#if !hasStandalone}
					<!-- The standalone home does not exist yet; show the section
					     anyway so a story without a world always has somewhere to
					     start. Creating one makes the universe on first use. -->
					<section class="universe-section">
						<header class="universe-header">
							<span class="universe-mark universe-mark-icon" title="Universe"
								><Icon name="universe" size={18} /></span
							>
							<div class="universe-identity">
								<h2 class="universe-name">Standalone stories</h2>
								<p class="universe-description">
									Stories that stand on their own, outside any shared world.
								</p>
							</div>
							<div class="universe-actions row-actions">
								<NewMenu
									label="New story"
									items={[{ label: 'New standalone story', onSelect: startStandaloneStory }]}
									note={STANDALONE_NOTE}
								/>
							</div>
						</header>
						<div class="story-grid">
							{#if newStoryFor === 'standalone'}
								<form class="card-add card-add-form" method="POST" action="?/createStandaloneStory">
									{#if form?.scope === 'standalone' && form.message}
										<p class="form-error" role="alert">{form.message}</p>
									{/if}
									<!-- svelte-ignore a11y_autofocus (the field only appears on the card click) -->
									<input
										class="input"
										type="text"
										name="title"
										aria-label="New standalone story"
										placeholder="Story title"
										required
										autofocus
										onkeydown={(e) => {
											if (e.key === 'Escape') newStoryFor = null;
										}}
									/>
									<div class="card-add-actions">
										<button class="btn btn-primary btn-sm" type="submit">Create story</button>
										<button
											class="btn btn-ghost btn-sm"
											type="button"
											onclick={() => (newStoryFor = null)}
										>
											Cancel
										</button>
									</div>
								</form>
							{:else}
								<div class="collection-empty">
									<p class="collection-empty-text">
										No standalone stories yet. A story that does not share a world lives here.
									</p>
									<NewMenu
										label="New standalone story"
										variant="primary"
										size="md"
										align="start"
										items={[{ label: 'New standalone story', onSelect: startStandaloneStory }]}
										note={STANDALONE_NOTE}
									/>
								</div>
							{/if}
						</div>
					</section>
				{/if}

				{#if data.trashedUniverses.length > 0}
					<section class="universe-section">
						<h2 class="universe-mark recent-mark">Deleted universes</h2>
						{#if form?.scope === 'trash' && form.message}
							<p class="form-error" role="alert">{form.message}</p>
						{/if}
						<div class="trash-list">
							{#each data.trashedUniverses as item (item.id)}
								<div class="trash-uni">
									<span class="trash-uni-name">{item.name}</span>
									<span class="trash-uni-when">
										{item.daysLeft > 0
											? `kept for ${item.daysLeft} more ${item.daysLeft === 1 ? 'day' : 'days'}`
											: 'about to be deleted for good'}
									</span>
									<form method="POST" action="?/restoreUniverse">
										<input type="hidden" name="universeId" value={item.id} />
										<button class="btn btn-ghost btn-sm" type="submit">Restore</button>
									</form>
									<form
										method="POST"
										action="?/destroyUniverse"
										onsubmit={(e) => {
											if (
												!confirm(
													`Delete "${item.name}" forever? Everything in it goes and cannot be restored after this.`
												)
											)
												e.preventDefault();
										}}
									>
										<input type="hidden" name="universeId" value={item.id} />
										<button class="btn btn-ghost btn-sm trash-forever" type="submit">
											Delete forever
										</button>
									</form>
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<p class="lib-foot">
					New here? Read the <a href={resolve('/docs')}>help</a>.
				</p>
			</div>
		</div>
	</div>
{/snippet}

<style>
	.recent-mark {
		min-width: 0;
		display: block;
		margin-bottom: var(--space-4, 16px);
	}
	.new-inline {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.new-inline .input {
		width: 220px;
	}
	.card-add-form {
		display: flex;
		flex-direction: column;
		gap: 10px;
		justify-content: center;
		padding: 18px;
		cursor: default;
	}
	.card-add-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.trash-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.trash-uni {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		border: 1px dashed var(--border);
		border-radius: var(--radius, 9px);
	}
	.trash-uni-name {
		font-weight: 600;
		font-size: 13.5px;
		color: var(--text-muted);
	}
	.trash-uni-when {
		flex: 1;
		color: var(--text-faint);
		font-size: 12.5px;
	}
	.trash-forever:hover {
		color: var(--danger, #c0564f);
	}
	.lib-foot {
		color: var(--text-faint);
		font-size: 12.5px;
		margin: 28px 0 0;
	}
	.lib-foot a {
		color: inherit;
	}
</style>
