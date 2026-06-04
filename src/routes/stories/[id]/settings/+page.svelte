<script lang="ts">
	import { resolve } from '$app/paths';
	import { entityColor } from '$lib/entity-color';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const coverColor = $derived(entityColor(data.story.title));
</script>

<svelte:head>
	<title>{data.story.title} - Settings - Codex</title>
</svelte:head>

<main>
	<nav>
		<a href={resolve('/')}>Library</a> /
		<a href={resolve('/universes/[id]', { id: data.universe.id })}>{data.universe.name}</a> /
		<a href={resolve('/stories/[id]', { id: data.story.id })}>{data.story.title}</a>
	</nav>
	<h1>Story settings</h1>

	<form method="POST" action="?/update">
		{#if form?.action === 'update' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'update' && form.saved}
			<p role="status">Saved.</p>
		{/if}
		<label>
			Title
			<input type="text" name="title" value={data.story.title} required />
		</label>
		<label>
			Author
			<input type="text" name="author" value={data.story.author ?? ''} />
		</label>
		<label>
			Brief
			<input type="text" name="brief" value={data.story.brief ?? ''} />
		</label>
		<label>
			Description
			<textarea name="description" rows="4">{data.story.descriptionMd ?? ''}</textarea>
		</label>
		<button type="submit">Save</button>
	</form>

	<h2>Cover</h2>
	{#if data.story.coverAssetId}
		<img class="cover" src="/assets/{data.story.coverAssetId}" alt="Story cover" />
	{:else}
		<svg class="cover" viewBox="0 0 200 300" role="img" aria-label="Default cover">
			<rect width="200" height="300" rx="6" style="fill: {coverColor}" />
			<text x="100" y="150" text-anchor="middle" fill="#fff" font-size="16" font-family="serif">
				{data.story.title.slice(0, 18)}
			</text>
		</svg>
	{/if}
	{#if data.assetsConfigured}
		<form method="POST" action="?/setCover" enctype="multipart/form-data">
			{#if form?.action === 'cover' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			{#if form?.action === 'cover' && form.saved}
				<p role="status">Cover saved.</p>
			{/if}
			<label>
				Cover image
				<input
					type="file"
					name="cover"
					accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
					required
				/>
			</label>
			<button type="submit">Upload cover</button>
		</form>
	{:else}
		<p>Image uploads need the ASSET_S3_* variables set; see .env.example.</p>
	{/if}

	<h2>Export</h2>
	<ul class="exports">
		<!-- eslint-disable svelte/no-navigation-without-resolve (file downloads and the print view) -->
		<li>
			<a href={`${resolve('/stories/[id]', { id: data.story.id })}/export`} download>
				Markdown (.zip)
			</a>
			- every scene as a markdown file, images bundled
		</li>
		<li>
			<a href={`${resolve('/stories/[id]', { id: data.story.id })}/epub`} download>EPUB</a>
			- for e-readers
		</li>
		<li>
			<a href={`${resolve('/stories/[id]', { id: data.story.id })}/print`}>PDF</a>
			- opens a print view; choose "Save as PDF" in the print dialog
		</li>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</ul>

	<h2>History</h2>
	{#if data.timeline.length === 0}
		<p>Recent changes to this story's scenes and outline appear here.</p>
	{:else}
		<ul class="timeline">
			{#each data.timeline as row (row.id)}
				<li>
					<span class="t-name">{row.entityName ?? 'Untitled'}</span>
					<span class="t-what">
						{row.label ?? (row.reason === 'checkpoint' ? 'checkpoint' : (row.reason ?? 'autosave'))}
					</span>
					<span class="t-when">{row.createdAt.toLocaleString()}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<form method="POST" action="?/delete">
		<button type="submit" class="danger">Delete story</button>
	</form>
</main>

<style>
	.cover {
		width: 120px;
		height: 180px;
		object-fit: cover;
		border-radius: 6px;
		display: block;
		margin-bottom: 0.5rem;
	}
	.timeline {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.timeline li {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.3rem 0;
		border-bottom: 1px dashed var(--border, #ddd);
		font-size: 0.9rem;
	}
	.t-name {
		font-weight: 600;
	}
	.t-what {
		color: var(--text-muted, #666);
	}
	.t-when {
		margin-left: auto;
		color: var(--text-faint, #999);
		font-size: 0.8rem;
	}
	main {
		max-width: 36rem;
		margin: 4rem auto 0;
		padding: 0 1rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.error {
		color: var(--danger, #b00020);
	}
	.danger {
		color: var(--danger, #b00020);
		margin-top: 1.5rem;
	}
</style>
