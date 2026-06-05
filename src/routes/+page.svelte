<script lang="ts">
	import { resolve } from '$app/paths';
	import Landing from '$lib/components/Landing.svelte';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import PaletteButton from '$lib/components/PaletteButton.svelte';
	import { entityColor } from '$lib/entity-color';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>{data.user ? 'Library - Codex' : 'Codex - A writing tool'}</title>
</svelte:head>

{#if !data.user}
	<Landing />
{:else}
	{@render library()}
{/if}

{#snippet library()}
	<div class="page-shell">
		<header class="topbar">
			<a class="brand" href={resolve('/')}>
				<span class="brand-name">Codex</span>
			</a>
			<span class="spacer"></span>
			<PaletteButton />
			<UserMenu />
		</header>

		<main class="library page-body">
			<div class="lib-head">
				<h1>Library</h1>
				<p class="lib-sub">Your universes, and the stories inside them.</p>
			</div>

			{#if data.universes.length === 0}
				<section class="lib-card lib-empty-card">
					<p>No universes yet. A universe holds the worldbuilding your stories share.</p>
				</section>
			{:else}
				{#each data.universes as universe (universe.id)}
					{@const universeStories = data.stories.filter(
						(story) => story.universeId === universe.id
					)}
					<section class="lib-card">
						<div class="lib-card-head">
							<span class="badge sm" style="background: {entityColor(universe.name)}">
								{universe.name.slice(0, 1).toUpperCase()}
							</span>
							<a class="lib-universe" href={resolve('/universes/[id]/plan', { id: universe.id })}>
								{universe.name}
							</a>
							<a class="lib-settings" href={resolve('/universes/[id]', { id: universe.id })}>
								Settings
							</a>
						</div>
						{#if universeStories.length === 0}
							<p class="lib-none">No stories yet.</p>
						{:else}
							<ul class="lib-stories">
								{#each universeStories as story (story.id)}
									<li>
										<a href={resolve('/stories/[id]', { id: story.id })}>{story.title}</a>
										{#if story.brief}<span class="lib-brief">{story.brief}</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/each}
			{/if}

			<section class="lib-card">
				<form class="lib-new" method="POST" action="?/createUniverse">
					{#if form?.scope === 'universe' && form.message}
						<p class="lib-error" role="alert">{form.message}</p>
					{/if}
					<label class="lib-new-label" for="new-universe">New universe</label>
					<div class="lib-new-row">
						<input
							id="new-universe"
							class="input"
							type="text"
							name="name"
							placeholder="Name"
							required
						/>
						<button class="btn btn-primary" type="submit">Create universe</button>
					</div>
				</form>
			</section>

			<p class="lib-foot">
				New here? Read the <a href={resolve('/docs')}>help</a>.
			</p>
		</main>
	</div>
{/snippet}

<style>
	.library {
		max-width: 680px;
		margin: 0 auto;
		padding: 28px 20px 60px;
		width: 100%;
	}
	.lib-head {
		margin-bottom: 22px;
	}
	.lib-head h1 {
		font-size: 24px;
		font-weight: 650;
		letter-spacing: -0.015em;
		margin: 0 0 4px;
	}
	.lib-sub {
		color: var(--text-muted);
		font-size: 13.5px;
		margin: 0;
	}
	.lib-card {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		padding: 16px 18px;
		margin-bottom: 14px;
	}
	.lib-empty-card p {
		color: var(--text-muted);
		font-size: 13.5px;
		margin: 0;
	}
	.lib-card-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.lib-universe {
		font-size: 15.5px;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--text);
		text-decoration: none;
	}
	.lib-universe:hover {
		color: var(--accent);
	}
	.lib-settings {
		margin-left: auto;
		font-size: 12.5px;
		color: var(--text-muted);
		text-decoration: none;
	}
	.lib-settings:hover {
		color: var(--text);
	}
	.lib-none {
		color: var(--text-faint);
		font-size: 13px;
		margin: 10px 0 0;
	}
	.lib-stories {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
	}
	.lib-stories li {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 7px 0;
		border-top: 1px dashed var(--border);
	}
	.lib-stories a {
		color: var(--text);
		font-size: 13.5px;
		text-decoration: none;
	}
	.lib-stories a:hover {
		color: var(--accent);
	}
	.lib-brief {
		color: var(--text-faint);
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.lib-new-label {
		display: block;
		font-size: 12.5px;
		font-weight: 600;
		margin-bottom: 7px;
	}
	.lib-new-row {
		display: flex;
		gap: 8px;
	}
	.lib-new-row .input {
		flex: 1;
	}
	.lib-error {
		color: var(--danger, #b00020);
		font-size: 13px;
		margin: 0 0 8px;
	}
	.lib-foot {
		color: var(--text-muted);
		font-size: 13px;
	}
</style>
