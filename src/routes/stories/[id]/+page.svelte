<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>{data.story.title} - Codex</title>
</svelte:head>

<main>
	<nav>
		<a href={resolve('/')}>Library</a> /
		<a href={resolve('/universes/[id]', { id: data.universe.id })}>{data.universe.name}</a>
	</nav>
	<h1>{data.story.title}</h1>
	{#if data.story.brief}
		<p>{data.story.brief}</p>
	{/if}

	<h2>Story settings</h2>
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

	<form method="POST" action="?/delete">
		<button type="submit" class="danger">Delete story</button>
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
</style>
