<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { CATEGORY_COLORS, entityColor } from '$lib/entity-color';
	import Icon from '$lib/components/Icon.svelte';
	import PaletteButton from '$lib/components/PaletteButton.svelte';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import NotificationBell from '$lib/components/NotificationBell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// One section at a time, like the account page; categories and history
	// can both grow long.
	type Section = 'details' | 'categories' | 'history' | 'export';
	const NAV: { id: Section; label: string }[] = [
		{ id: 'details', label: 'Details' },
		{ id: 'categories', label: 'Entity categories' },
		{ id: 'history', label: 'History' },
		{ id: 'export', label: 'Import and export' }
	];
	let active = $state<Section>('details');
	// A failed or saved POST reloads the page; land back on the section the
	// form lives in.
	$effect(() => {
		if (form?.action === 'categories') active = 'categories';
		else if (form?.action === 'update') active = 'details';
		else if (form?.action === 'import') active = 'export';
	});

	// The import form is enhanced so the chosen file survives the preview
	// step; the Import button then posts the same file to the run action.
	let importBusy = $state(false);
	const importPreview = $derived(form?.action === 'import' ? (form.preview ?? null) : null);
	const importResult = $derived(form?.action === 'import' ? (form.imported ?? null) : null);
	const NOTE_OUTCOMES = {
		match: 'matches an existing entry; the note attaches to it.',
		create: 'has no match; a new entry will be created.',
		ambiguous: 'matches more than one entry; the note will be skipped.'
	} as const;

	const universeColor = $derived(entityColor(data.universe.name));

	// The category editor works on a local copy.
	type CategoryDraft = {
		key: number;
		id: string | null;
		name: string;
		color: string | null;
		entries: number;
	};
	let nextKey = 0;
	// The plain form POST reloads the page, so the initial value is the
	// fresh one every time this component mounts.
	// svelte-ignore state_referenced_locally
	let drafts = $state<CategoryDraft[]>(
		data.categories.map((category) => ({
			key: nextKey++,
			id: category.id,
			name: category.name,
			color: category.color,
			entries: category.entries
		}))
	);

	const categoriesPayload = $derived(
		JSON.stringify(drafts.map((draft) => ({ id: draft.id, name: draft.name, color: draft.color })))
	);

	function moveDraft(index: number, direction: -1 | 1) {
		const to = index + direction;
		if (to < 0 || to >= drafts.length) return;
		[drafts[index], drafts[to]] = [drafts[to], drafts[index]];
	}

	// The history filters work over the loaded rows.
	let historyFilter = $state<'all' | 'checkpoints' | 'week' | 'world'>('all');
	const FILTERS = [
		{ id: 'all', label: 'All' },
		{ id: 'checkpoints', label: 'Checkpoints only' },
		{ id: 'week', label: 'Last 7 days' },
		{ id: 'world', label: 'Worldbuilding only' }
	] as const;

	const KIND_LABELS: Record<string, string> = {
		scene: 'Scene',
		character: 'Character',
		place: 'Place',
		lore_entry: 'Lore'
	};

	const filteredTimeline = $derived(
		data.timeline.filter((row) => {
			if (historyFilter === 'checkpoints') return row.reason === 'checkpoint';
			if (historyFilter === 'world') return row.entityType !== 'scene';
			if (historyFilter === 'week') {
				return row.createdAt.getTime() > Date.now() - 7 * 86_400_000;
			}
			return true;
		})
	);

	// Rows grouped under Today / Yesterday / the day's date.
	const timelineGroups = $derived.by(() => {
		const groups: { label: string; rows: typeof data.timeline }[] = [];
		const today = new Date().toDateString();
		const yesterday = new Date(Date.now() - 86_400_000).toDateString();
		for (const row of filteredTimeline) {
			const day = row.createdAt.toDateString();
			const label =
				day === today
					? 'Today'
					: day === yesterday
						? 'Yesterday'
						: row.createdAt.toLocaleDateString(undefined, {
								day: 'numeric',
								month: 'long',
								year: 'numeric'
							});
			const last = groups[groups.length - 1];
			if (last && last.label === label) last.rows.push(row);
			else groups.push({ label, rows: [row] });
		}
		return groups;
	});

	function entryTime(row: (typeof data.timeline)[number]): string {
		return row.createdAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}

	function previewHref(row: (typeof data.timeline)[number]): string {
		if (row.entityType === 'scene' && row.storySlug) {
			return `/stories/${row.storySlug}?scene=${row.entityId}&revision=${row.id}`;
		}
		return `/universes/${data.universe.slug}/plan?entity=${row.entityId}&revision=${row.id}`;
	}

	let restoring = $state<string | null>(null);
	async function restoreRow(row: (typeof data.timeline)[number]) {
		restoring = row.id;
		try {
			const response = await fetch(`/api/revisions/${row.id}/restore`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ entityType: row.entityType, entityId: row.entityId })
			});
			if (response.ok) await invalidateAll();
		} finally {
			restoring = null;
		}
	}
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
		<NotificationBell />
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
					<button
						class="nav-item"
						class:active={active === item.id}
						type="button"
						onclick={() => (active = item.id)}
					>
						{item.label}
					</button>
				{/each}
			</nav>
		</aside>

		<main class="admin-main page-body">
			<div class="admin-main-inner">
				<div class="admin-head">
					<p class="admin-eyebrow">Universe</p>
					<h1 class="admin-title">{data.universe.name} - settings</h1>
					<p class="admin-lede">The world your stories share, and everything about it.</p>
				</div>

				<section class="admin-section" class:active={active === 'details'}>
					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">About this universe</h2>
							<p class="admin-block-sub">
								The universe is the container that holds your shared worldbuilding. Every story you
								write belongs to one.
							</p>
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
								<span class="field-hint">
									The web address follows the name: /universes/{data.universe.slug}. Renaming moves
									the address; the old one stops working.
								</span>
							</div>
							<div class="field">
								<label for="u-description">Description</label>
								<textarea id="u-description" class="input" name="description" rows="6"
									>{data.universe.descriptionMd ?? ''}</textarea
								>
								<span class="field-hint">Markdown is fine. Shown on the library card.</span>
							</div>
							<div class="settings-actions">
								<button class="btn btn-primary" type="submit">Save changes</button>
							</div>
						</form>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Contents</h2>
							<p class="admin-block-sub">What this universe currently contains.</p>
						</div>
						<div class="stat-grid">
							<div class="stat-tile">
								<div class="n">{data.contents.stories.toLocaleString('en-US')}</div>
								<div class="l">{data.contents.stories === 1 ? 'story' : 'stories'}</div>
							</div>
							<div class="stat-tile">
								<div class="n">{data.contents.characters.toLocaleString('en-US')}</div>
								<div class="l">{data.contents.characters === 1 ? 'character' : 'characters'}</div>
							</div>
							<div class="stat-tile">
								<div class="n">{data.contents.places.toLocaleString('en-US')}</div>
								<div class="l">{data.contents.places === 1 ? 'place' : 'places'}</div>
							</div>
							<div class="stat-tile">
								<div class="n">{data.contents.lore.toLocaleString('en-US')}</div>
								<div class="l">{data.contents.lore === 1 ? 'lore entry' : 'lore entries'}</div>
							</div>
							<div class="stat-tile">
								<div class="n">{data.contents.words.toLocaleString('en-US')}</div>
								<div class="l">total words</div>
							</div>
						</div>
					</div>
				</section>

				<section class="admin-section" class:active={active === 'categories'}>
					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Entity categories</h2>
							<p class="admin-block-sub">
								Categories group your lore entries and colour their sidebar dots, mention
								underlines, and badges. A category can only be deleted once nothing uses it.
							</p>
						</div>
						<form method="POST" action="?/saveCategories">
							{#if form?.action === 'categories' && form.message}
								<p class="form-error" role="alert">{form.message}</p>
							{/if}
							{#if form?.action === 'categories' && form.saved}
								<p class="form-saved" role="status">Saved.</p>
							{/if}
							<div class="category-list">
								{#each drafts as draft, index (draft.key)}
									<div class="category-row">
										<span class="category-tools">
											<button
												class="tool-btn turn-up"
												type="button"
												title="Move category up"
												disabled={index === 0}
												onclick={() => moveDraft(index, -1)}
											>
												<Icon name="chevron" size={12} />
											</button>
											<button
												class="tool-btn turn-down"
												type="button"
												title="Move category down"
												disabled={index === drafts.length - 1}
												onclick={() => moveDraft(index, 1)}
											>
												<Icon name="chevron" size={12} />
											</button>
										</span>
										<span
											class="category-color-dot"
											class:empty={!draft.color}
											style="background: {draft.color ?? 'transparent'}"
										></span>
										<select
											class="category-color-select"
											aria-label="Category colour"
											bind:value={draft.color}
										>
											<option value={null}>No colour</option>
											{#each CATEGORY_COLORS as choice (choice.token)}
												<option value={choice.token}>{choice.label}</option>
											{/each}
										</select>
										<input
											class="category-name-input"
											type="text"
											aria-label="Category name"
											bind:value={draft.name}
											required
										/>
										<span class="category-count">
											{draft.entries.toLocaleString('en-US')}
											{draft.entries === 1 ? 'entry' : 'entries'}
										</span>
										<button
											class="category-delete"
											type="button"
											title={draft.entries > 0
												? 'Move or delete its entries first'
												: 'Delete category'}
											disabled={draft.entries > 0}
											onclick={() => (drafts = drafts.filter((row) => row !== draft))}
										>
											<Icon name="plus" size={13} />
										</button>
									</div>
								{/each}
							</div>
							<button
								class="card-add category-add"
								type="button"
								onclick={() =>
									(drafts = [
										...drafts,
										{
											key: nextKey++,
											id: null,
											name: '',
											color: null,
											entries: 0
										}
									])}
							>
								<span class="plus">+</span><span>Add category</span>
							</button>
							<input type="hidden" name="categories" value={categoriesPayload} />
							<div class="settings-actions">
								<button class="btn btn-primary" type="submit">Save categories</button>
							</div>
						</form>
					</div>
				</section>

				<section class="admin-section" class:active={active === 'history'}>
					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">History</h2>
							<p class="admin-block-sub">
								Every change across every story, character, place, and lore entry in this universe.
								For a single item's history, open it and use its History tab.
							</p>
						</div>
						<div class="revision-filters">
							<span class="revision-filter-label">Filter</span>
							{#each FILTERS as filter (filter.id)}
								<button
									class="revision-filter-chip"
									class:active={historyFilter === filter.id}
									type="button"
									onclick={() => (historyFilter = filter.id)}
								>
									{filter.label}
								</button>
							{/each}
						</div>
						{#if filteredTimeline.length === 0}
							<p class="block-empty">Nothing recorded yet. Changes appear here as you work.</p>
						{:else}
							<div class="revision-panel">
								{#each timelineGroups as group (group.label)}
									<div class="revision-group-label">{group.label}</div>
									{#each group.rows as row (row.id)}
										<div class="revision-entry">
											<span
												class="revision-dot"
												class:revision-dot-checkpoint={row.reason === 'checkpoint'}
												class:revision-dot-autosave={row.reason !== 'checkpoint'}
											></span>
											<div class="revision-main">
												<div class="revision-source">
													<span class="revision-source-kind">
														{KIND_LABELS[row.entityType] ?? row.entityType}
													</span>
													{row.entityName ?? 'Untitled'}
												</div>
												<div class="revision-meta">
													<span class="revision-time">{entryTime(row)}</span>
													<span class="revision-kind">{row.storyTitle ?? 'Universe'}</span>
													{#if row.label}
														<span class="revision-note revision-note-checkpoint">
															"{row.label}"
														</span>
													{:else if row.reason && row.reason !== 'autosave'}
														<span class="revision-note">{row.reason}</span>
													{/if}
												</div>
												{#if row.reason === 'checkpoint'}
													<div class="revision-actions">
														<!-- eslint-disable svelte/no-navigation-without-resolve (app path with query parameters) -->
														<a class="btn btn-ghost btn-sm" href={previewHref(row)}>Preview</a>
														<!-- eslint-enable svelte/no-navigation-without-resolve -->
														<button
															class="btn btn-secondary btn-sm"
															type="button"
															disabled={restoring === row.id}
															onclick={() => restoreRow(row)}
														>
															{restoring === row.id ? 'Restoring...' : 'Restore'}
														</button>
													</div>
												{/if}
											</div>
										</div>
									{/each}
								{/each}
								<div class="revision-footer">
									{data.revisionCount.toLocaleString('en-US')} revisions across this universe
								</div>
							</div>
						{/if}
					</div>
				</section>

				<section class="admin-section" class:active={active === 'export'}>
					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Export universe</h2>
							<p class="admin-block-sub">
								Everything in this universe, bundled into a single archive.
							</p>
						</div>
						<div class="danger-row">
							<div class="danger-row-text">
								<h3 class="danger-row-title">Markdown archive</h3>
								<p class="danger-row-body">
									A zip of markdown files organised into folders: characters, places, lore, and one
									folder per story, each with YAML front matter and bundled images.
								</p>
							</div>
							<div class="danger-row-actions">
								<!-- eslint-disable svelte/no-navigation-without-resolve (download endpoint) -->
								<a class="btn btn-secondary" href="/universes/{data.universe.slug}/export" download>
									Download .zip
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</div>
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Import a story</h2>
							<p class="admin-block-sub">
								Bring a story export zip back in as a new story in this universe. Upload the file,
								check the preview, then import.
							</p>
						</div>
						<form
							method="POST"
							action="?/previewImport"
							enctype="multipart/form-data"
							use:enhance={() => {
								importBusy = true;
								return async ({ update }) => {
									importBusy = false;
									await update({ reset: false });
								};
							}}
						>
							<div class="import-pick">
								<input type="file" name="archive" accept=".zip,application/zip" required />
								<button class="btn btn-secondary" type="submit" disabled={importBusy}>
									Preview
								</button>
							</div>
							{#if form?.action === 'import' && form.message}
								<p class="field-hint import-error" role="status">{form.message}</p>
							{/if}
							{#if importResult}
								<div class="import-report" role="status">
									<p>
										Imported {importResult.sceneCount}
										{importResult.sceneCount === 1
											? 'scene'
											: 'scenes'}{importResult.notesAttached > 0
											? ` and ${importResult.notesAttached} ${importResult.notesAttached === 1 ? 'story note' : 'story notes'}`
											: ''}{importResult.entitiesCreated > 0
											? `, creating ${importResult.entitiesCreated} ${importResult.entitiesCreated === 1 ? 'new entry' : 'new entries'}`
											: ''}.
									</p>
									{#each importResult.problems as problem (problem)}
										<p class="import-flag">{problem}</p>
									{/each}
									<!-- eslint-disable svelte/no-navigation-without-resolve (slug known at runtime) -->
									<a class="btn btn-secondary" href="/stories/{importResult.slug}">Open the story</a
									>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								</div>
							{:else if importPreview}
								<div class="import-report">
									<p>
										"{importPreview.storyTitle}": {importPreview.chapterCount}
										{importPreview.chapterCount === 1 ? 'chapter' : 'chapters'},
										{importPreview.sceneCount}
										{importPreview.sceneCount === 1 ? 'scene' : 'scenes'},
										{importPreview.words.toLocaleString('en-US')} words{importPreview.assetCount > 0
											? `, ${importPreview.assetCount} ${importPreview.assetCount === 1 ? 'image' : 'images'}`
											: ''}.
									</p>
									{#if importPreview.titleTaken}
										<p class="import-flag">
											A story named "{importPreview.storyTitle}" already exists here; this import
											creates a second one.
										</p>
									{/if}
									{#if importPreview.assetCount > 0 && !importPreview.assetsConfigured}
										<p class="import-flag">
											Image storage is not configured, so the bundled images will not be imported.
										</p>
									{/if}
									{#if importPreview.notes.length > 0}
										<ul class="import-notes">
											{#each importPreview.notes as note (note.kind + note.name)}
												<li>
													<strong>{note.name}</strong>
													({note.kind === 'lore' ? 'lore entry' : note.kind})
													{NOTE_OUTCOMES[note.outcome]}
												</li>
											{/each}
										</ul>
									{/if}
									{#each importPreview.problems as problem (problem)}
										<p class="import-flag">{problem}</p>
									{/each}
									<button
										class="btn btn-primary"
										type="submit"
										formaction="?/runImport"
										disabled={importBusy}
									>
										Import story
									</button>
								</div>
							{/if}
						</form>
					</div>

					<div class="admin-block danger">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Danger zone</h2>
							<p class="admin-block-sub">
								Deleting a universe removes every story, character, place, and lore entry inside it.
							</p>
						</div>
						<div class="danger-row">
							<div class="danger-row-text">
								<h3 class="danger-row-title">Delete this universe</h3>
								<p class="danger-row-body">
									All {data.contents.stories.toLocaleString('en-US')}
									{data.contents.stories === 1 ? 'story' : 'stories'},
									{data.contents.characters.toLocaleString('en-US')}
									{data.contents.characters === 1 ? 'character' : 'characters'},
									{data.contents.places.toLocaleString('en-US')}
									{data.contents.places === 1 ? 'place' : 'places'}, and
									{data.contents.lore.toLocaleString('en-US')}
									{data.contents.lore === 1 ? 'lore entry' : 'lore entries'} go with it. The universe
									sits in your library's deleted list for {data.trashDays} days, where you can restore
									it; after that everything is deleted for good. Export an archive first if in doubt.
								</p>
							</div>
							<div class="danger-row-actions">
								<form
									method="POST"
									action="?/delete"
									onsubmit={(e) => {
										if (
											!confirm(
												`Delete this universe and everything in it? You can restore it from the library for ${data.trashDays} days.`
											)
										)
											e.preventDefault();
									}}
								>
									<button class="btn btn-danger" type="submit">Delete universe</button>
								</form>
							</div>
						</div>
					</div>
				</section>
			</div>
		</main>
	</div>
</div>

<style>
	.import-pick {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.import-pick input[type='file'] {
		font-size: 13px;
		color: var(--text-muted);
	}
	.import-error {
		color: var(--danger);
		margin: 8px 0 0;
	}
	.import-report {
		margin-top: 12px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-inset);
		display: grid;
		gap: 8px;
		justify-items: start;
	}
	.import-report p {
		margin: 0;
		font-size: 13px;
	}
	.import-flag {
		color: var(--text-muted);
	}
	.import-notes {
		margin: 0;
		padding-left: 18px;
		font-size: 13px;
		color: var(--text-muted);
		display: grid;
		gap: 2px;
	}
	.category-tools {
		display: inline-flex;
		gap: 1px;
		flex: none;
	}
	.category-tools .tool-btn.turn-up :global(svg) {
		transform: rotate(-90deg);
	}
	.category-tools .tool-btn.turn-down :global(svg) {
		transform: rotate(90deg);
	}
	.category-color-dot {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 1px solid var(--border);
		flex: none;
	}
	.category-color-dot.empty {
		background: repeating-linear-gradient(
			45deg,
			var(--bg-inset),
			var(--bg-inset) 3px,
			transparent 3px,
			transparent 6px
		);
	}
	.category-color-select {
		height: 28px;
		padding: 0 6px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-inset);
		color: var(--text);
		cursor: pointer;
		flex: none;
	}
	.category-delete {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		flex: none;
	}
	.category-delete :global(svg) {
		transform: rotate(45deg);
	}
	.category-delete:hover:not(:disabled) {
		color: var(--danger, #c0564f);
		background: var(--bg-hover);
	}
	.category-delete:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.category-add {
		margin-top: 10px;
		min-height: 42px;
		width: 100%;
		cursor: pointer;
		font-family: inherit;
	}
</style>
