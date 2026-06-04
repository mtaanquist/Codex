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
		{#if form?.message}
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
				{#if form?.message}
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
		<h2>Public archive admin</h2>
		<form method="POST" action="?/setArchive">
			<label>
				User email
				<input type="email" name="email" required />
			</label>
			<label class="inline">
				<input type="checkbox" name="enabled" checked />
				Public archive enabled
			</label>
			<button type="submit">Apply</button>
			{#if form && 'archiveSaved' in form && form.archiveSaved}
				<span role="status">Saved.</span>
			{/if}
		</form>
		{#if data.published.length > 0}
			<ul class="timeline">
				{#each data.published as edition (edition.id)}
					<li>
						<span class="t-name" class:failed={edition.removedAt !== null}>
							@{edition.handle}/{edition.title}
						</span>
						<span class="t-what">
							{edition.removedAt
								? 'taken down'
								: edition.isCurrent
									? 'current'
									: 'superseded'}{edition.isAdult ? ', adult' : ''}
						</span>
						<span class="t-when">{edition.publishedAt.toLocaleString()}</span>
						{#if !edition.removedAt}
							<form method="POST" action="?/takedown">
								<input type="hidden" name="publicationId" value={edition.id} />
								<button type="submit">Take down</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<h2>Backups</h2>
		{#if !data.backupsConfigured}
			<p>
				Off-site backups are not configured. Set the BACKUP_S3_* variables (see .env.example) and
				restart; the worker then uploads a nightly database dump.
			</p>
		{:else}
			<form method="POST" action="?/runBackup">
				<button type="submit">Back up now</button>
				{#if form && 'backupQueued' in form && form.backupQueued}
					<span role="status">Backup queued. Refresh to see the result.</span>
				{/if}
			</form>
		{/if}
		{#if data.backupRuns.length > 0}
			<ul class="timeline">
				{#each data.backupRuns as run (run.id)}
					<li>
						<span class="t-name" class:failed={run.status === 'failed'}>{run.status}</span>
						<span class="t-what">
							{run.trigger}{run.sizeBytes ? `, ${(run.sizeBytes / 1024).toFixed(0)} KB` : ''}
							{run.error ? ` - ${run.error}` : ''}
						</span>
						<span class="t-when">{run.startedAt.toLocaleString()}</span>
					</li>
				{/each}
			</ul>
		{/if}
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
	.timeline {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0 0;
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
	.t-name.failed {
		color: #b00020;
	}
	.t-what {
		color: #666;
	}
	.t-when {
		margin-left: auto;
		color: #999;
		font-size: 0.8rem;
	}
	label.inline {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
</style>
