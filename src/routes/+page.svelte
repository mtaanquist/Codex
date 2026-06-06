<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import Landing from '$lib/components/Landing.svelte';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import PaletteButton from '$lib/components/PaletteButton.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The header's New universe button and each section's new-story card
	// swap to an inline title form when clicked.
	let creatingUniverse = $state(false);
	let newStoryFor = $state<string | null>(null);

	// A failed submit reloads the page; reopen the form it came from.
	$effect(() => {
		if (form?.scope === 'universe' && form.message) creatingUniverse = true;
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
		return `${n.toLocaleString('en-US')} ${n === 1 ? noun : plural}`;
	}

	function universeStories(universeId: string) {
		return data.stories.filter((story) => story.universeId === universeId);
	}
</script>

<svelte:head>
	<title>{data.user ? 'Library - Codex' : 'Codex - A writing tool'}</title>
</svelte:head>

{#if !data.user}
	<Landing />
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
			{#if story.words === 0 && story.outlineNodes > 0}
				<span>{count(story.outlineNodes, 'outline node')}</span>
			{:else}
				<span>{count(story.chapters, 'chapter')}</span>
			{/if}
			<span class="story-card-meta-sep">·</span>
			<span>{count(story.words, 'word')}</span>
			<span class="story-card-meta-sep">·</span>
			<span>edited {story.editedLabel}</span>
		</div>
	</a>
{/snippet}

{#snippet library()}
	<div class="page-shell">
		<header class="topbar">
			<a class="brand" href={resolve('/')}>
				<span class="brand-mark" style="color: #fff"><Icon name="feather" size={15} /></span>
				<span class="brand-name">Codex</span>
			</a>
			<span class="spacer"></span>
			<PaletteButton />
			<UserMenu />
		</header>

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
							)} · {totalWords.toLocaleString('en-US')} words in total
						</p>
					</div>
					<div class="page-actions">
						{#if creatingUniverse}
							<form class="new-inline" method="POST" action="?/createUniverse">
								<!-- svelte-ignore a11y_autofocus (the field only appears on the button click) -->
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
							</form>
						{:else}
							<button
								class="btn btn-secondary"
								type="button"
								onclick={() => (creatingUniverse = true)}
							>
								New universe
							</button>
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

				{#each data.universes as universe (universe.id)}
					<section class="universe-section">
						<header class="universe-header">
							<span class="universe-mark">Universe</span>
							<div class="universe-identity">
								<a
									class="universe-name-link"
									href={resolve('/universes/[id]/plan', { id: universe.slug })}
								>
									<h2 class="universe-name">{universe.name}</h2>
								</a>
								{#if universe.descriptionMd}
									<p class="universe-description">{universe.descriptionMd}</p>
								{/if}
							</div>
							<div class="universe-actions">
								<a
									class="btn btn-ghost btn-sm"
									href={resolve('/universes/[id]', { id: universe.slug })}
								>
									Edit universe
								</a>
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
									<button class="btn btn-primary btn-sm" type="submit">Create story</button>
								</form>
							{:else}
								<button class="card-add" type="button" onclick={() => (newStoryFor = universe.id)}>
									<span class="plus">+</span><span>New story in this universe</span>
								</button>
							{/if}
						</div>
					</section>
				{/each}

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
	button.card-add {
		cursor: pointer;
		font-family: inherit;
	}
	.card-add-form {
		display: flex;
		flex-direction: column;
		gap: 8px;
		justify-content: center;
		cursor: default;
	}
	.card-add-form .btn {
		align-self: flex-start;
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
