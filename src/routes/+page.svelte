<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Library - Codex</title>
</svelte:head>

<main>
	<header>
		<h1>Codex</h1>
		<form method="POST" action="?/signout">
			<span>{data.user.displayName}</span>
			<a href={resolve('/account')}>Account</a>
			<button type="submit">Sign out</button>
		</form>
	</header>

	<h2>Universes</h2>
	{#if data.universes.length === 0}
		<p>No universes yet. A universe holds the worldbuilding your stories share.</p>
	{:else}
		{#each data.universes as universe (universe.id)}
			{@const universeStories = data.stories.filter((story) => story.universeId === universe.id)}
			<section>
				<h3>
					<a href={resolve('/universes/[id]/plan', { id: universe.id })}>{universe.name}</a>
					<a class="settings" href={resolve('/universes/[id]', { id: universe.id })}>Settings</a>
				</h3>
				{#if universeStories.length === 0}
					<p>No stories yet.</p>
				{:else}
					<ul>
						{#each universeStories as story (story.id)}
							<li><a href={resolve('/stories/[id]', { id: story.id })}>{story.title}</a></li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}
	{/if}

	<form method="POST" action="?/createUniverse">
		{#if form?.scope === 'universe' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<label>
			New universe
			<input type="text" name="name" placeholder="Name" required />
		</label>
		<button type="submit">Create universe</button>
	</form>

	<h2>Preferences</h2>
	<form method="POST" action="?/savePreferences">
		<label>
			Entity autocomplete
			<select name="entityAutocomplete" value={data.preferences.entityAutocomplete}>
				<option value="popup">Popup list</option>
				<option value="ghost">Ghost text</option>
				<option value="off">Off</option>
			</select>
		</label>
		<label>
			Scene marks in the story view
			<select name="continuousSceneMarks" value={data.preferences.continuousSceneMarks}>
				<option value="shown">Shown</option>
				<option value="hidden">Hidden</option>
			</select>
		</label>
		<button type="submit">Save preferences</button>
		{#if form && 'prefSaved' in form && form.prefSaved}
			<p role="status">Saved.</p>
		{/if}
	</form>

	{#if data.archive.enabled}
		<h2>Public archive</h2>
		{#if data.archive.handle}
			<p>
				Your shelf lives at
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (public reader path) -->
				<a href="/@{data.archive.handle}">/@{data.archive.handle}</a>. Publish stories from their
				settings page.
			</p>
		{:else}
			<form method="POST" action="?/claimHandle">
				{#if form?.scope === 'handle' && form.message}
					<p class="error" role="alert">{form.message}</p>
				{/if}
				<label>
					Claim a public handle
					<input
						type="text"
						name="handle"
						placeholder="your-name"
						pattern="[a-z0-9][a-z0-9-]+"
						required
					/>
				</label>
				<button type="submit">Claim handle</button>
			</form>
		{/if}
	{/if}

	{#if data.isAdmin}
		<h2>Administration</h2>
		<p><a href={resolve('/admin')}>Open the site admin panel</a></p>
	{/if}
</main>

<style>
	main {
		max-width: 36rem;
		margin: 4rem auto 0;
		font-family: system-ui, sans-serif;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	header form {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
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
	h3 {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.settings {
		font-size: 0.8rem;
		font-weight: normal;
	}
</style>
