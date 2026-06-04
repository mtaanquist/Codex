<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>{data.universe.name} - Codex</title>
</svelte:head>

<main>
	<nav><a href={resolve('/')}>Library</a></nav>
	<h1>{data.universe.name}</h1>

	<h2>Stories</h2>
	{#if data.stories.length === 0}
		<p>No stories yet.</p>
	{:else}
		<ul>
			{#each data.stories as story (story.id)}
				<li><a href={resolve('/stories/[id]', { id: story.id })}>{story.title}</a></li>
			{/each}
		</ul>
	{/if}

	<form method="POST" action="?/createStory">
		{#if form?.action === 'createStory' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<label>
			New story
			<input type="text" name="title" placeholder="Title" required />
		</label>
		<button type="submit">Create story</button>
	</form>

	<h2>Universe settings</h2>
	<form method="POST" action="?/update">
		{#if form?.action === 'update' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'update' && form.saved}
			<p role="status">Saved.</p>
		{/if}
		<label>
			Name
			<input type="text" name="name" value={data.universe.name} required />
		</label>
		<label>
			Description
			<textarea name="description" rows="4">{data.universe.descriptionMd ?? ''}</textarea>
		</label>
		<button type="submit">Save</button>
	</form>

	<h2>History</h2>
	{#if data.timeline.length === 0}
		<p>Recent changes to this universe's characters, places, and lore appear here.</p>
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
		{#if form?.action === 'delete' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<button type="submit" class="danger">Delete universe</button>
	</form>
</main>

<style>
	main {
		max-width: 36rem;
		margin: 4rem auto 0;
		font-family: system-ui, sans-serif;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.error {
		color: #b00020;
	}
	.danger {
		color: #b00020;
		margin-top: 1.5rem;
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
		border-bottom: 1px dashed #ddd;
		font-size: 0.9rem;
	}
	.t-name {
		font-weight: 600;
	}
	.t-what {
		color: #666;
	}
	.t-when {
		margin-left: auto;
		color: #999;
		font-size: 0.8rem;
	}
</style>
