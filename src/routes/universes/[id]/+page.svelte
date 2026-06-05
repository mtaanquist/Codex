<script lang="ts">
	import { resolve } from '$app/paths';
	import { entityColor } from '$lib/entity-color';
	import PaletteButton from '$lib/components/PaletteButton.svelte';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const NAV = [
		{ id: 'details', label: 'Details' },
		{ id: 'stories', label: 'Stories' },
		{ id: 'history', label: 'History' },
		{ id: 'danger', label: 'Danger zone' }
	];

	const universeColor = $derived(entityColor(data.universe.name));
</script>

<svelte:head>
	<title>{data.universe.name} - Codex</title>
</svelte:head>

<div class="page-shell">
	<header class="topbar">
		<a class="brand" href={resolve('/')}>
			<span class="brand-name">Codex</span>
		</a>
		<span class="divider"></span>
		<a class="back-link" href={resolve('/universes/[id]/plan', { id: data.universe.slug })}>
			<svg
				viewBox="0 0 12 12"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"><polyline points="7.5 2.5 3 6 7.5 9.5" /></svg
			>
			{data.universe.name}
		</a>
		<span class="spacer"></span>
		<PaletteButton />
		<UserMenu />
	</header>

	<div class="admin-shell">
		<aside class="admin-sidebar">
			<div class="admin-sidebar-title">
				<span class="ic badge sm" style="background: {universeColor}; color: #fff;">
					{data.universe.name.slice(0, 1).toUpperCase()}
				</span>
				<div>
					<div class="tt">{data.universe.name}</div>
					<div class="st">Universe</div>
				</div>
			</div>
			<nav class="admin-nav">
				<div class="admin-nav-label">Universe settings</div>
				{#each NAV as item (item.id)}
					<a class="nav-item" href="#{item.id}">{item.label}</a>
				{/each}
			</nav>
		</aside>

		<main class="admin-main page-body">
			<div class="admin-main-inner">
				<div class="admin-head">
					<p class="admin-eyebrow">Universe</p>
					<h1 class="admin-title">{data.universe.name}</h1>
					<p class="admin-lede">The world your stories share, and everything about it.</p>
				</div>

				<div class="admin-block" id="details">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Details</h2>
						<p class="admin-block-sub">The universe's name and what it is about.</p>
					</div>
					<form method="POST" action="?/update">
						{#if form?.action === 'update' && form.message}
							<p class="form-error" role="alert">{form.message}</p>
						{/if}
						{#if form?.action === 'update' && form.saved}
							<p class="form-saved" role="status">Saved.</p>
						{/if}
						<div class="field">
							<label for="u-name">Name</label>
							<input
								id="u-name"
								class="input"
								type="text"
								name="name"
								value={data.universe.name}
								required
							/>
						</div>
						<div class="field">
							<label for="u-slug">Slug</label>
							<input
								id="u-slug"
								class="input"
								type="text"
								name="slug"
								value={data.universe.slug}
								required
								spellcheck="false"
							/>
							<span class="field-hint">
								The universe's web address: /universes/{data.universe.slug}. Lowercase letters,
								numbers, and hyphens. Changing it moves the address; the old one stops working.
							</span>
						</div>
						<div class="field">
							<label for="u-description">Description</label>
							<textarea id="u-description" class="input" name="description" rows="4"
								>{data.universe.descriptionMd ?? ''}</textarea
							>
						</div>
						<div class="settings-actions">
							<button class="btn btn-primary" type="submit">Save</button>
						</div>
					</form>
				</div>

				<div class="admin-block" id="stories">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Stories</h2>
						<p class="admin-block-sub">The stories written in this universe.</p>
					</div>
					{#if data.stories.length === 0}
						<p class="block-empty">No stories yet.</p>
					{:else}
						<ul class="story-list">
							{#each data.stories as story (story.id)}
								<li>
									<a href={resolve('/stories/[id]', { id: story.slug })}>{story.title}</a>
									{#if story.brief}<span class="story-brief">{story.brief}</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}
					<form class="new-story" method="POST" action="?/createStory">
						{#if form?.action === 'createStory' && form.message}
							<p class="form-error" role="alert">{form.message}</p>
						{/if}
						<div class="field">
							<label for="u-new-story">New story</label>
							<div class="new-story-row">
								<input
									id="u-new-story"
									class="input"
									type="text"
									name="title"
									placeholder="Title"
									required
								/>
								<button class="btn btn-primary" type="submit">Create story</button>
							</div>
						</div>
					</form>
				</div>

				<div class="admin-block" id="history">
					<div class="admin-block-head">
						<h2 class="admin-block-title">History</h2>
						<p class="admin-block-sub">
							Recent changes to this universe's characters, places, and lore.
						</p>
					</div>
					{#if data.timeline.length === 0}
						<p class="block-empty">Nothing recorded yet. Changes appear here as you work.</p>
					{:else}
						<ul class="timeline">
							{#each data.timeline as row (row.id)}
								<li>
									<span class="t-name">{row.entityName ?? 'Untitled'}</span>
									<span class="t-what">
										{row.label ??
											(row.reason === 'checkpoint' ? 'checkpoint' : (row.reason ?? 'autosave'))}
									</span>
									<span class="t-when">{row.createdAt.toLocaleString()}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<div class="admin-block danger" id="danger">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Danger zone</h2>
						<p class="admin-block-sub">A universe can only be deleted once its stories are gone.</p>
					</div>
					<form method="POST" action="?/delete">
						{#if form?.action === 'delete' && form.message}
							<p class="form-error" role="alert">{form.message}</p>
						{/if}
						<button class="btn btn-danger" type="submit">Delete universe</button>
					</form>
				</div>
			</div>
		</main>
	</div>
</div>

<style>
	.form-saved {
		color: var(--text-muted);
		font-size: 13px;
		margin: 0 0 10px;
	}
	.form-error {
		color: var(--danger, #c0564f);
		font-size: 13px;
		margin: 0 0 10px;
	}
	.block-empty {
		color: var(--text-muted);
		font-size: 13px;
		margin: 0;
	}
	.story-list {
		list-style: none;
		margin: 0 0 16px;
		padding: 0;
	}
	.story-list li {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 8px 0;
		border-bottom: 1px dashed var(--border);
	}
	.story-list a {
		color: var(--text);
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
	}
	.story-list a:hover {
		color: var(--accent);
	}
	.story-brief {
		color: var(--text-faint);
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.new-story-row {
		display: flex;
		gap: 8px;
	}
	.new-story-row .input {
		flex: 1;
	}
	.timeline {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.timeline li {
		display: flex;
		gap: 12px;
		align-items: baseline;
		padding: 6px 0;
		border-bottom: 1px dashed var(--border);
		font-size: 13px;
	}
	.t-name {
		font-weight: 600;
	}
	.t-what {
		color: var(--text-muted);
	}
	.t-when {
		margin-left: auto;
		color: var(--text-faint);
		font-size: 12px;
		white-space: nowrap;
	}
</style>
