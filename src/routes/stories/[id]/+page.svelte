<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import SceneEditor, { type SaveStatus } from '$lib/components/SceneEditor.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Focus mode hides the chrome around the prose; Esc leaves it.
	let focus = $state(false);

	let saveStatus = $state<SaveStatus>('idle');
	const selectedSceneId = $derived(data.selectedScene?.id);
	$effect(() => {
		void selectedSceneId;
		saveStatus = 'idle';
	});

	// Chapters start expanded; collapsing is per-visit state.
	let collapsed = new SvelteSet<string>();

	const initials = $derived(
		data.user.displayName
			.split(/\s+/)
			.map((part) => part[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	const orphanScenes = $derived(data.scenes.filter((scene) => scene.chapterId === null));

	function chapterScenes(chapterId: string) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}

	function words(count: number) {
		if (count <= 0) return '';
		return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
	}
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
		{saveStatus}
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
						{#each data.chapters as chapter, index (chapter.id)}
							{@const list = chapterScenes(chapter.id)}
							{@const open = !collapsed.has(chapter.id)}
							<div class="chapter">
								<button
									class="chapter-row"
									type="button"
									onclick={() =>
										collapsed.has(chapter.id)
											? collapsed.delete(chapter.id)
											: collapsed.add(chapter.id)}
								>
									<span class="tw" class:open><Icon name="chevron" size={12} /></span>
									<span class="chapter-name">{chapter.title ?? `Chapter ${index + 1}`}</span>
									<span class="chapter-meta">{list.length}</span>
								</button>
								{#if open}
									<div class="scenes">
										{#each list as scene (scene.id)}
											<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
											<a
												class="scene-row"
												class:active={scene.id === data.selectedScene?.id}
												href={`${resolve('/stories/[id]', { id: data.story.id })}?scene=${scene.id}`}
											>
												<span class="scene-status st-{scene.status}" title={scene.status}></span>
												<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
												{#if scene.wordCount > 0}
													<span class="scene-words">{words(scene.wordCount)}</span>
												{/if}
											</a>
											<!-- eslint-enable svelte/no-navigation-without-resolve -->
										{/each}
										<form method="POST" action="?/createScene">
											<input type="hidden" name="chapterId" value={chapter.id} />
											<button class="outline-add scene" type="submit">
												<Icon name="plus" size={12} /> New scene
											</button>
										</form>
									</div>
								{/if}
							</div>
						{/each}
						{#if orphanScenes.length > 0}
							<div class="scenes">
								{#each orphanScenes as scene (scene.id)}
									<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
									<a
										class="scene-row"
										class:active={scene.id === data.selectedScene?.id}
										href={`${resolve('/stories/[id]', { id: data.story.id })}?scene=${scene.id}`}
									>
										<span class="scene-status st-{scene.status}" title={scene.status}></span>
										<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
										{#if scene.wordCount > 0}
											<span class="scene-words">{words(scene.wordCount)}</span>
										{/if}
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								{/each}
							</div>
						{/if}
						<form method="POST" action="?/createChapter">
							<button class="outline-add" type="submit">
								<Icon name="plus" size={13} /> New chapter
							</button>
						</form>
					</div>
				</div>
			</div>
		</aside>
		<main class="pane center">
			{#if data.selectedScene}
				{#key data.selectedScene.id}
					<SceneEditor
						sceneId={data.selectedScene.id}
						title={data.selectedScene.title}
						body={data.selectedScene.bodyMd}
						onStatus={(status) => (saveStatus = status)}
					/>
				{/key}
			{:else if data.scenes.length === 0}
				<div class="empty">
					<p>Create a chapter in the sidebar, then add a scene to it to start writing.</p>
				</div>
			{:else}
				<div class="empty">
					<p>Select a scene in the sidebar.</p>
				</div>
			{/if}
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
	.chapter-row {
		width: 100%;
		border: 0;
		background: none;
		text-align: left;
	}
	.scene-row {
		text-decoration: none;
		color: inherit;
	}
</style>
