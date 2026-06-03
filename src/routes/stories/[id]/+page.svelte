<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Focus mode hides the chrome around the prose; Esc leaves it.
	let focus = $state(false);

	const initials = $derived(
		data.user.displayName
			.split(/\s+/)
			.map((part) => part[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') focus = false;
	}}
/>

<svelte:head>
	<title>{data.story.title} - Codex</title>
</svelte:head>

<div class="app" class:focus-mode={focus}>
	<TopBar
		universe={{ id: data.universe.id, name: data.universe.name }}
		story={{ id: data.story.id, title: data.story.title }}
		{initials}
		onEnterFocus={() => (focus = true)}
	/>
	<div class="body">
		<aside class="pane left">
			<div class="left-head">
				<div class="seg full">
					<button class="seg-btn active" type="button">Write</button>
					<button class="seg-btn" type="button" disabled>Plan</button>
					<button class="seg-btn" type="button" disabled>Notes</button>
				</div>
			</div>
			<div class="left-scroll">
				<div class="outline">
					<div class="outline-head">
						<div class="story-switch">
							<span class="story-book"><Icon name="book" size={15} /></span>
							<span class="story-id">
								<span class="story-title">{data.story.title}</span>
								<span class="story-universe">{data.universe.name}</span>
							</span>
						</div>
					</div>
					<div class="chapters">
						<div class="empty">No chapters yet.</div>
					</div>
				</div>
			</div>
		</aside>
		<main class="pane center">
			<div class="empty">
				<p>The editor arrives here. For now, you can edit this story's details.</p>
				<a href={resolve('/stories/[id]/settings', { id: data.story.id })}>Story settings</a>
			</div>
		</main>
		<aside class="pane right">
			<div class="right-scroll">
				<div class="empty">Nothing to show yet.</div>
			</div>
		</aside>
	</div>

	{#if focus}
		<div class="focus-controls">
			<ThemeToggle />
			<button
				class="icon-btn"
				type="button"
				title="Exit focus (Esc)"
				onclick={() => (focus = false)}
			>
				<Icon name="compress" />
			</button>
		</div>
	{/if}
</div>

<style>
	.empty a {
		color: var(--accent);
		text-decoration: none;
	}
	.empty a:hover {
		text-decoration: underline;
	}
</style>
