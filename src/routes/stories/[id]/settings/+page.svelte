<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
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

	<form method="POST" action="?/delete">
		<button type="submit" class="danger">Delete story</button>
	</form>
</main>

<style>
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
