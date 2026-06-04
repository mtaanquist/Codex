<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { entityColor, entityLetter } from '$lib/entity-color';
	import Icon from '$lib/components/Icon.svelte';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
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

	const viewStory = $derived(data.view === 'story');
	const storyPath = $derived(resolve('/stories/[id]', { id: data.story.id }));

	// Entering the story view carries the open scene along; leaving it returns
	// there.
	const toggleHref = $derived(
		viewStory
			? data.returnSceneId
				? `${storyPath}?scene=${data.returnSceneId}`
				: storyPath
			: data.selectedScene
				? `${storyPath}?view=story&scene=${data.selectedScene.id}`
				: `${storyPath}?view=story`
	);

	// Right column tabs; History holds the open scene's timeline.
	let rightTab = $state<'reference' | 'history'>('reference');
	const sceneHref = $derived(
		data.selectedScene ? `${storyPath}?scene=${data.selectedScene.id}` : storyPath
	);

	function chapterScenes(chapterId: string) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}

	function docScenes(chapterId: string | null) {
		return (data.storyDoc ?? []).filter((scene) => scene.chapterId === chapterId);
	}

	function words(count: number) {
		if (count <= 0) return '';
		return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
	}

	// Drag-to-reorder. The drop target is a chapter (or the orphan list, null)
	// plus an insertion index; on drop the full order is sent to the server,
	// which renumbers global_position and position_in_chapter.
	let draggingSceneId = $state<string | null>(null);
	let dropTarget = $state<{ chapterId: string | null; index: number } | null>(null);

	function overScene(event: DragEvent, chapterId: string | null, index: number) {
		if (!draggingSceneId) return;
		event.preventDefault();
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const after = event.clientY > rect.top + rect.height / 2;
		dropTarget = { chapterId, index: index + (after ? 1 : 0) };
	}

	function overChapterHeader(event: DragEvent, chapterId: string) {
		if (!draggingSceneId) return;
		event.preventDefault();
		dropTarget = { chapterId, index: chapterScenes(chapterId).length };
	}

	function buildOrder(sceneId: string, target: { chapterId: string | null; index: number }) {
		const chapterLists = data.chapters.map((chapter) => ({
			id: chapter.id,
			sceneIds: chapterScenes(chapter.id).map((scene) => scene.id)
		}));
		const orphanSceneIds = orphanScenes.map((scene) => scene.id);
		let index = target.index;
		for (const chapter of chapterLists) {
			const at = chapter.sceneIds.indexOf(sceneId);
			if (at !== -1) {
				chapter.sceneIds.splice(at, 1);
				if (chapter.id === target.chapterId && at < index) index -= 1;
			}
		}
		const orphanAt = orphanSceneIds.indexOf(sceneId);
		if (orphanAt !== -1) {
			orphanSceneIds.splice(orphanAt, 1);
			if (target.chapterId === null && orphanAt < index) index -= 1;
		}
		if (target.chapterId === null) {
			orphanSceneIds.splice(index, 0, sceneId);
		} else {
			chapterLists
				.find((chapter) => chapter.id === target.chapterId)
				?.sceneIds.splice(index, 0, sceneId);
		}
		return { chapters: chapterLists, orphanSceneIds };
	}

	async function commitDrop(event: DragEvent) {
		event.preventDefault();
		if (!draggingSceneId || !dropTarget) return;
		const order = buildOrder(draggingSceneId, { ...dropTarget });
		draggingSceneId = null;
		dropTarget = null;
		await fetch(`/api/stories/${data.story.id}/scene-order`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(order)
		});
		await invalidateAll();
	}

	function endDrag() {
		draggingSceneId = null;
		dropTarget = null;
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
		storyView={{ active: viewStory, toggleHref }}
	/>
	<div class="body">
		<aside class="pane left">
			<div class="left-head">
				<div class="seg full">
					<button class="seg-btn active" type="button">Write</button>
					<a class="seg-btn seg-link" href={resolve('/stories/[id]/plan', { id: data.story.id })}>
						Plan
					</a>
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
									class:scene-target={dropTarget?.chapterId === chapter.id &&
										dropTarget.index === list.length &&
										!open}
									type="button"
									onclick={() =>
										collapsed.has(chapter.id)
											? collapsed.delete(chapter.id)
											: collapsed.add(chapter.id)}
									ondragover={(e) => overChapterHeader(e, chapter.id)}
									ondrop={commitDrop}
								>
									<span class="tw" class:open><Icon name="chevron" size={12} /></span>
									<span class="chapter-name">{chapter.title ?? `Chapter ${index + 1}`}</span>
									<span class="chapter-meta">{list.length}</span>
								</button>
								{#if open}
									<div class="scenes">
										{#each list as scene, si (scene.id)}
											{#if dropTarget?.chapterId === chapter.id && dropTarget.index === si}
												<div class="drop-line scene"></div>
											{/if}
											<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
											<a
												class="scene-row"
												class:active={scene.id === data.selectedScene?.id}
												href={viewStory ? `#scene-${scene.id}` : `${storyPath}?scene=${scene.id}`}
												draggable="true"
												ondragstart={(e) => {
													draggingSceneId = scene.id;
													e.dataTransfer?.setData('text/plain', scene.id);
												}}
												ondragover={(e) => overScene(e, chapter.id, si)}
												ondrop={commitDrop}
												ondragend={endDrag}
											>
												<span class="scene-status st-{scene.status}" title={scene.status}></span>
												<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
												{#if scene.wordCount > 0}
													<span class="scene-words">{words(scene.wordCount)}</span>
												{/if}
											</a>
											<!-- eslint-enable svelte/no-navigation-without-resolve -->
										{/each}
										{#if dropTarget?.chapterId === chapter.id && dropTarget.index === list.length && open}
											<div class="drop-line scene"></div>
										{/if}
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
								{#each orphanScenes as scene, si (scene.id)}
									{#if dropTarget?.chapterId === null && dropTarget.index === si}
										<div class="drop-line scene"></div>
									{/if}
									<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
									<a
										class="scene-row"
										class:active={scene.id === data.selectedScene?.id}
										href={viewStory ? `#scene-${scene.id}` : `${storyPath}?scene=${scene.id}`}
										draggable="true"
										ondragstart={(e) => {
											draggingSceneId = scene.id;
											e.dataTransfer?.setData('text/plain', scene.id);
										}}
										ondragover={(e) => overScene(e, null, si)}
										ondrop={commitDrop}
										ondragend={endDrag}
									>
										<span class="scene-status st-{scene.status}" title={scene.status}></span>
										<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
										{#if scene.wordCount > 0}
											<span class="scene-words">{words(scene.wordCount)}</span>
										{/if}
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								{/each}
								{#if dropTarget?.chapterId === null && dropTarget.index === orphanScenes.length}
									<div class="drop-line scene"></div>
								{/if}
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
			{#if viewStory}
				<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
				<div class="editor story-doc">
					<h1 class="doc-title">{data.story.title}</h1>
					{#if (data.storyDoc ?? []).length === 0}
						<div class="empty">
							<p>Nothing written yet. Switch back to the editor to add scenes.</p>
						</div>
					{/if}
					{#each data.chapters as chapter, index (chapter.id)}
						{@const docList = docScenes(chapter.id)}
						{#if docList.length > 0}
							<section class="doc-chapter" id="chapter-{chapter.id}">
								<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
								{#each docList as scene (scene.id)}
									<article class="doc-scene" id="scene-{scene.id}">
										<a
											class="doc-scene-mark"
											href={`${storyPath}?scene=${scene.id}`}
											title="Edit this scene"
										>
											{scene.title ?? 'Untitled scene'}
										</a>
										<div class="doc-scene-body">{scene.bodyMd}</div>
									</article>
								{/each}
							</section>
						{/if}
					{/each}
					{#if docScenes(null).length > 0}
						<section class="doc-chapter">
							<h2>Unfiled scenes</h2>
							{#each docScenes(null) as scene (scene.id)}
								<article class="doc-scene" id="scene-{scene.id}">
									<a
										class="doc-scene-mark"
										href={`${storyPath}?scene=${scene.id}`}
										title="Edit this scene"
									>
										{scene.title ?? 'Untitled scene'}
									</a>
									<div class="doc-scene-body">{scene.bodyMd}</div>
								</article>
							{/each}
						</section>
					{/if}
				</div>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{:else if data.selectedScene && data.revisionPreview}
				<div class="editor">
					<RevisionPreview
						revision={data.revisionPreview}
						currentBody={data.selectedScene.bodyMd}
						entityType="scene"
						entityId={data.selectedScene.id}
						exitHref={sceneHref}
					/>
				</div>
			{:else if data.selectedScene}
				{#key data.selectedScene.id}
					<SceneEditor
						sceneId={data.selectedScene.id}
						title={data.selectedScene.title}
						body={data.selectedScene.bodyMd}
						entities={data.mentionEntities}
						autocompleteMode={data.preferences.entityAutocomplete}
						onStatus={(status) => {
							saveStatus = status;
							// Refresh the tree so the sidebar name and word count track edits.
							if (status === 'saved') void invalidateAll();
						}}
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
			{#if data.selectedScene}
				<div class="right-head">
					<div class="rtabs">
						<button
							class="rtab"
							class:active={rightTab === 'reference'}
							type="button"
							onclick={() => (rightTab = 'reference')}
						>
							Reference
						</button>
						<button
							class="rtab"
							class:active={rightTab === 'history'}
							type="button"
							onclick={() => (rightTab = 'history')}
						>
							History
						</button>
					</div>
				</div>
			{/if}
			{#if data.selectedScene && rightTab === 'history'}
				<RevisionHistory
					entityType="scene"
					entityId={data.selectedScene.id}
					revisions={data.sceneRevisions}
					previewId={data.revisionPreview?.id}
					previewHref={(revisionId) => `${sceneHref}&revision=${revisionId}`}
				/>
			{:else}
				<div class="right-scroll">
					{#if data.selectedScene && data.inScene.length > 0}
						<div class="r-card">
							<h5>In this scene</h5>
							{#each data.inScene as entity (entity.id)}
								<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
								<a
									class="r-line"
									href={`${resolve('/stories/[id]/plan', { id: data.story.id })}?entity=${entity.id}`}
								>
									<span class="r-line-left">
										<span class="badge dot" style="background: {entityColor(entity.name)}">
											{entityLetter(entity.name)}
										</span>
										<span class="r-line-name">{entity.name}</span>
									</span>
									<span class="r-count">{entity.count}</span>
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/each}
						</div>
					{:else}
						<div class="empty">Nothing to show yet.</div>
					{/if}
				</div>
			{/if}
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
	.seg-link {
		text-decoration: none;
		text-align: center;
	}
	main.pane.center {
		scroll-behavior: smooth;
	}
	.doc-title {
		font-family: var(--font-content);
		font-size: 34px;
		font-weight: 600;
		letter-spacing: -0.015em;
		margin: 0 0 30px;
	}
	.doc-chapter {
		scroll-margin-top: 24px;
	}
	.doc-chapter h2 {
		font-family: var(--font-content);
		font-size: 23px;
		font-weight: 600;
		margin: 40px 0 16px;
	}
	.doc-scene {
		margin: 0 0 30px;
		scroll-margin-top: 24px;
	}
	.doc-scene-mark {
		display: block;
		color: var(--text-faint);
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		text-decoration: none;
		margin: 0 0 8px;
	}
	.doc-scene-mark:hover {
		color: var(--accent);
	}
	.doc-scene-body {
		font-family: var(--font-content);
		font-size: 17.5px;
		line-height: 1.7;
		white-space: pre-wrap;
	}
</style>
