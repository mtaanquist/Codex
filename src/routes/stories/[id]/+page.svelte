<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { focusMode } from '$lib/focus-mode.svelte';
	import { entityColor, entityLetter } from '$lib/entity-color';
	import Icon from '$lib/components/Icon.svelte';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import SceneEditor, { type SaveStatus } from '$lib/components/SceneEditor.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import SessionPanel from '$lib/components/SessionPanel.svelte';
	import SidebarSearch from '$lib/components/SidebarSearch.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Picking which entity a shared name means: store the pin, then let the
	// data refresh re-render the underlines (the editor reconfigures its
	// mentions when the pins change).
	async function pinMention(name: string, target: { type: string; id: string }) {
		const response = await fetch(`/api/stories/${data.story.id}/mention-pins`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name, targetType: target.type, targetId: target.id })
		});
		if (response.ok) await invalidateAll();
	}

	const mentionOptions = $derived({
		storyMembers: data.storyMemberIds,
		pins: data.mentionPins,
		onPin: pinMention,
		entityHref: (entity: { id: string }) =>
			`/universes/${data.universe.slug}/plan?entity=${entity.id}`
	});

	// The editor's create-from-selection menu; the refreshed page data
	// reconfigures the underlines, so the new name lights up in place.
	async function createEntity(
		type: 'character' | 'place' | 'lore_entry',
		name: string
	): Promise<string | null> {
		const response = await fetch(`/api/stories/${data.story.id}/entities`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ type, name })
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as { message?: string } | null;
			return body?.message ?? 'Could not create it.';
		}
		await invalidateAll();
		return null;
	}

	// Focus mode hides the chrome around the prose; Esc leaves it, and so
	// does leaving the page. Shared state, so the palette can toggle it.
	$effect(() => () => {
		focusMode.on = false;
	});

	let saveStatus = $state<SaveStatus>('idle');
	const selectedSceneId = $derived(data.selectedScene?.id);
	$effect(() => {
		void selectedSceneId;
		saveStatus = 'idle';
	});

	// A palette jump to a text match carries the searched text; the editor
	// selects the first occurrence so the eye lands on it.
	const findText = $derived(page.url.searchParams.get('find'));

	// An appears-in jump carries the mention's character offset instead.
	const findAt = $derived.by(() => {
		const raw = page.url.searchParams.get('at');
		if (raw === null) return null;
		const at = Number.parseInt(raw, 10);
		return Number.isInteger(at) && at >= 0 ? at : null;
	});

	// The mention index rebuilds in the background after a save, so the
	// Reference tab can trail the text by a couple of seconds. While the
	// open scene's index watermark is behind its last edit (the worker's
	// own staleness test), keep refreshing until it catches up - bounded,
	// so a stopped worker does not leave the page polling forever.
	const MENTION_POLL_MS = 2000;
	const MENTION_POLL_LIMIT = 10;
	let mentionPolls = 0;
	$effect(() => {
		const scene = data.selectedScene;
		if (!scene) return;
		const stale = !scene.mentionsIndexedAt || scene.mentionsIndexedAt < scene.updatedAt;
		if (!stale || mentionPolls >= MENTION_POLL_LIMIT) return;
		const timer = setTimeout(() => {
			mentionPolls += 1;
			void invalidateAll();
		}, MENTION_POLL_MS);
		return () => clearTimeout(timer);
	});

	// Chapters start expanded; collapsing is per-visit state.
	let collapsed = new SvelteSet<string>();

	// Which chapter shows its inline rename field, if any.
	let renamingChapterId = $state<string | null>(null);

	// The deleted-scenes list starts closed; its count shows in the header.
	let trashOpen = $state(false);

	// Right-click menu for sidebar rows: chapter tools or the scene delete.
	// Same pattern as the editor's selection menu.
	type RowMenuTarget =
		| { kind: 'chapter'; id: string; index: number }
		| { kind: 'scene'; id: string };
	let rowMenu = $state<{ x: number; y: number; target: RowMenuTarget } | null>(null);

	function openRowMenu(event: MouseEvent, target: RowMenuTarget) {
		event.preventDefault();
		rowMenu = { x: event.clientX, y: event.clientY, target };
	}

	// The book switcher's menu, toggled from the sidebar header.
	let storyMenuOpen = $state(false);

	function onWindowPointerDown(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		if (storyMenuOpen && !target?.closest('.outline-head')) storyMenuOpen = false;
		if (rowMenu && !target?.closest('.row-menu')) rowMenu = null;
	}

	const orphanScenes = $derived(data.scenes.filter((scene) => scene.chapterId === null));

	const viewStory = $derived(data.view === 'story');
	const storyPath = $derived(resolve('/stories/[id]', { id: data.story.slug }));

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
	let rightTab = $state<'reference' | 'history' | 'session'>('reference');
	const sceneHref = $derived(
		data.selectedScene ? `${storyPath}?scene=${data.selectedScene.id}` : storyPath
	);

	function chapterScenes(chapterId: string) {
		return data.scenes.filter((scene) => scene.chapterId === chapterId);
	}

	// The sidebar filter: a matching chapter keeps all its scenes, otherwise
	// only matching scenes show, and a chapter with nothing left hides.
	// While filtering, chapters stay open and dragging is off.
	let sidebarQuery = $state('');
	const sceneQuery = $derived(sidebarQuery.trim().toLowerCase());
	function nameMatches(title: string | null, fallback: string) {
		return (title ?? fallback).toLowerCase().includes(sceneQuery);
	}
	const visibleOrphans = $derived(
		sceneQuery === ''
			? orphanScenes
			: orphanScenes.filter((scene) => nameMatches(scene.title, 'Untitled scene'))
	);

	function docScenes(chapterId: string | null) {
		return (data.storyDoc ?? []).filter((scene) => scene.chapterId === chapterId);
	}

	// The continuous view stitches one editor per scene; vertical arrows at
	// an editor's edge move the caret into the neighbouring scene.
	const docOrder = $derived([
		...data.chapters.flatMap((chapter) => docScenes(chapter.id).map((scene) => scene.id)),
		...docScenes(null).map((scene) => scene.id)
	]);
	let docEditors: Record<string, { focusEdge: (edge: 'start' | 'end') => void } | undefined> =
		$state({});

	function focusNeighbor(sceneId: string, direction: 'up' | 'down') {
		const index = docOrder.indexOf(sceneId);
		const target = docOrder[index + (direction === 'down' ? 1 : -1)];
		if (target) docEditors[target]?.focusEdge(direction === 'down' ? 'start' : 'end');
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
		if (e.key !== 'Escape') return;
		if (storyMenuOpen) {
			storyMenuOpen = false;
			return;
		}
		if (rowMenu) {
			rowMenu = null;
			return;
		}
		focusMode.on = false;
	}}
	onpointerdown={onWindowPointerDown}
/>

<svelte:head>
	<title>{data.story.title} - Codex</title>
</svelte:head>

<!-- Sidebar actions reload the page; carrying the open scene keeps it open. -->
{#snippet openSceneField()}
	{#if selectedSceneId}
		<input type="hidden" name="openSceneId" value={selectedSceneId} />
	{/if}
{/snippet}

<div class="app" class:focus-mode={focusMode.on}>
	<TopBar
		universe={{ slug: data.universe.slug, name: data.universe.name }}
		story={{ slug: data.story.slug, title: data.story.title }}
		onEnterFocus={() => (focusMode.on = true)}
		{saveStatus}
		storyView={{ active: viewStory, toggleHref }}
		help={{ topic: 'editor', label: 'the editor' }}
	/>
	<div class="body">
		<aside class="pane left">
			<div class="left-head">
				<div class="seg full">
					<button class="seg-btn active" type="button">Write</button>
					<a class="seg-btn seg-link" href={resolve('/stories/[id]/plan', { id: data.story.slug })}>
						Plan
					</a>
					<button class="seg-btn" type="button" disabled>Notes</button>
				</div>
				<SidebarSearch bind:query={sidebarQuery} placeholder="Filter chapters and scenes..." />
			</div>
			<div class="left-scroll">
				<div class="outline">
					<div class="outline-head">
						<!-- The book switcher: with more than one story in the
						     universe, the header opens a menu to jump between them. -->
						<button
							class="story-switch"
							type="button"
							disabled={data.storySiblings.length < 2}
							onclick={() => (storyMenuOpen = !storyMenuOpen)}
						>
							<span class="story-book"><Icon name="book" size={15} /></span>
							<span class="story-id">
								<span class="story-title">{data.story.title}</span>
								<span class="story-universe">{data.universe.name}</span>
							</span>
							{#if data.storySiblings.length > 1}
								<span class="story-caret" class:open={storyMenuOpen}>
									<Icon name="chevron" size={13} />
								</span>
							{/if}
						</button>
						{#if storyMenuOpen}
							<div class="story-menu">
								{#each data.storySiblings as sibling (sibling.id)}
									<button
										type="button"
										class:active={sibling.id === data.story.id}
										onclick={async () => {
											storyMenuOpen = false;
											if (sibling.id !== data.story.id) {
												// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path from an owned slug
												await goto(`/stories/${sibling.slug}`);
											}
										}}
									>
										<span class="sm-title">{sibling.title}</span>
										<span class="sm-sub">
											{sibling.chapters} chapter{sibling.chapters === 1 ? '' : 's'} · {words(
												sibling.words
											) || '0'} words
										</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="chapters">
						{#each data.chapters as chapter, index (chapter.id)}
							{@const chapterMatch =
								sceneQuery === '' || nameMatches(chapter.title, `Chapter ${index + 1}`)}
							{@const list = chapterMatch
								? chapterScenes(chapter.id)
								: chapterScenes(chapter.id).filter((scene) =>
										nameMatches(scene.title, 'Untitled scene')
									)}
							{@const open = sceneQuery !== '' || !collapsed.has(chapter.id)}
							{#if chapterMatch || list.length > 0}
								<div class="chapter">
									{#if renamingChapterId === chapter.id}
										<form class="chapter-rename" method="POST" action="?/renameChapter">
											<input type="hidden" name="chapterId" value={chapter.id} />
											{@render openSceneField()}
											<!-- svelte-ignore a11y_autofocus (the field only appears on the rename click) -->
											<input
												class="chapter-rename-input"
												name="title"
												value={chapter.title ?? ''}
												placeholder={`Chapter ${index + 1}`}
												autofocus
												onkeydown={(e) => {
													if (e.key === 'Escape') renamingChapterId = null;
												}}
											/>
											<button class="tool-btn" type="submit" title="Save chapter name">Save</button>
										</form>
									{:else}
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
											oncontextmenu={(e) =>
												openRowMenu(e, { kind: 'chapter', id: chapter.id, index })}
											ondragover={(e) => overChapterHeader(e, chapter.id)}
											ondrop={commitDrop}
										>
											<span class="tw" class:open><Icon name="chevron" size={12} /></span>
											<span class="chapter-name">{chapter.title ?? `Chapter ${index + 1}`}</span>
											<span class="chapter-meta">{list.length}</span>
										</button>
									{/if}
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
													oncontextmenu={(e) => openRowMenu(e, { kind: 'scene', id: scene.id })}
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
											{#if sceneQuery === ''}
												<form method="POST" action="?/createScene">
													<input type="hidden" name="chapterId" value={chapter.id} />
													<button class="outline-add scene" type="submit">
														<Icon name="plus" size={12} /> New scene
													</button>
												</form>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						{/each}
						{#if visibleOrphans.length > 0}
							<div class="chapter">
								<span class="chapter-row as-label unfiled-head">
									<span class="chapter-name">Unfiled scenes</span>
									<span class="chapter-meta">{visibleOrphans.length}</span>
								</span>
								<div class="scenes">
									{#each visibleOrphans as scene, si (scene.id)}
										{#if dropTarget?.chapterId === null && dropTarget.index === si}
											<div class="drop-line scene"></div>
										{/if}
										<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
										<a
											class="scene-row"
											class:active={scene.id === data.selectedScene?.id}
											href={viewStory ? `#scene-${scene.id}` : `${storyPath}?scene=${scene.id}`}
											draggable={sceneQuery === ''}
											oncontextmenu={(e) => openRowMenu(e, { kind: 'scene', id: scene.id })}
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
									{#if dropTarget?.chapterId === null && dropTarget.index === visibleOrphans.length}
										<div class="drop-line scene"></div>
									{/if}
								</div>
							</div>
						{/if}
						{#if sceneQuery !== '' && visibleOrphans.length === 0 && !data.chapters.some((chapter, index) => nameMatches(chapter.title, `Chapter ${index + 1}`) || chapterScenes(chapter.id).some( (scene) => nameMatches(scene.title, 'Untitled scene') ))}
							<div class="search-empty">No chapters or scenes match.</div>
						{/if}
						{#if sceneQuery === ''}
							<form method="POST" action="?/createChapter">
								<button class="outline-add" type="submit">
									<Icon name="plus" size={13} /> New chapter
								</button>
							</form>
						{/if}
						{#if sceneQuery === '' && data.trashedScenes.length > 0}
							<div class="chapter trash">
								<button class="chapter-row" type="button" onclick={() => (trashOpen = !trashOpen)}>
									<span class="tw" class:open={trashOpen}><Icon name="chevron" size={12} /></span>
									<span class="chapter-name">Deleted scenes</span>
									<span class="chapter-meta">{data.trashedScenes.length}</span>
								</button>
								{#if trashOpen}
									<div class="scenes">
										{#each data.trashedScenes as scene (scene.id)}
											<div class="trash-row">
												<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
												{#if scene.wordCount > 0}
													<span class="scene-words">{words(scene.wordCount)}</span>
												{/if}
												<form method="POST" action="?/restoreScene">
													<input type="hidden" name="sceneId" value={scene.id} />
													<button class="tool-btn" type="submit" title="Restore scene">
														<Icon name="restore" size={12} />
													</button>
												</form>
												<form
													method="POST"
													action="?/destroyScene"
													onsubmit={(e) => {
														if (
															!confirm(
																'Delete this scene forever? It cannot be restored after this.'
															)
														)
															e.preventDefault();
													}}
												>
													<input type="hidden" name="sceneId" value={scene.id} />
													{@render openSceneField()}
													<button class="tool-btn danger" type="submit" title="Delete forever">
														<Icon name="trash" size={12} />
													</button>
												</form>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</aside>
		<main class="pane center">
			{#if viewStory}
				{#snippet docScene(scene: NonNullable<typeof data.storyDoc>[number])}
					<article class="doc-scene" id="scene-{scene.id}">
						{#if data.preferences.continuousSceneMarks === 'shown'}
							<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
							<a
								class="doc-scene-mark"
								href={`${storyPath}?scene=${scene.id}`}
								title="Edit this scene alone"
							>
								{scene.title ?? 'Untitled scene'}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
						<SceneEditor
							bind:this={docEditors[scene.id]}
							compact
							sceneId={scene.id}
							title={scene.title}
							body={scene.bodyMd}
							entities={data.mentionEntities}
							{mentionOptions}
							autocompleteMode={data.preferences.entityAutocomplete}
							editingMode={data.preferences.editingMode}
							spellCheck={data.preferences.spellCheck}
							writingLanguage={data.preferences.writingLanguage}
							imageUniverseId={data.universe.id}
							markers={data.storyDocMarkers[scene.id] ?? []}
							onCreateEntity={createEntity}
							onCrossBoundary={(direction) => focusNeighbor(scene.id, direction)}
							onStatus={(status) => {
								saveStatus = status;
								if (status === 'saved') void invalidateAll();
							}}
						/>
					</article>
				{/snippet}
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
									{@render docScene(scene)}
								{/each}
							</section>
						{/if}
					{/each}
					{#if docScenes(null).length > 0}
						<section class="doc-chapter">
							<h2>Unfiled scenes</h2>
							{#each docScenes(null) as scene (scene.id)}
								{@render docScene(scene)}
							{/each}
						</section>
					{/if}
				</div>
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
						{findText}
						{findAt}
						entities={data.mentionEntities}
						{mentionOptions}
						autocompleteMode={data.preferences.entityAutocomplete}
						editingMode={data.preferences.editingMode}
						spellCheck={data.preferences.spellCheck}
						writingLanguage={data.preferences.writingLanguage}
						imageUniverseId={data.universe.id}
						markers={data.sceneMarkers}
						onCreateEntity={createEntity}
						onStatus={(status) => {
							saveStatus = status;
							// Refresh the tree so the sidebar name and word count track edits.
							if (status === 'saved') {
								mentionPolls = 0;
								void invalidateAll();
							}
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
			<div class="right-head">
				<div class="rtabs">
					{#if data.selectedScene}
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
					{/if}
					<button
						class="rtab"
						class:active={rightTab === 'session'}
						type="button"
						onclick={() => (rightTab = 'session')}
					>
						Session
					</button>
				</div>
			</div>
			{#if rightTab === 'session'}
				<SessionPanel universeSlug={data.universe.slug} storyId={data.story.id} />
			{:else if data.selectedScene && rightTab === 'history'}
				<RevisionHistory
					entityType="scene"
					entityId={data.selectedScene.id}
					revisions={data.sceneRevisions}
					previewId={data.revisionPreview?.id}
					previewHref={(revisionId) => `${sceneHref}&revision=${revisionId}`}
				/>
			{:else}
				<div class="right-scroll">
					{#if data.storyTodos.length > 0}
						<div class="r-card">
							<h5>To do</h5>
							{#each data.storyTodos as todo, ti (ti)}
								<div class="todo-row">
									{#if todo.markerId}
										<button
											class="todo-check"
											type="button"
											title="Mark done"
											onclick={async () => {
												await fetch(`/api/markers/${todo.markerId}`, {
													method: 'PUT',
													headers: { 'content-type': 'application/json' },
													body: JSON.stringify({ resolved: true })
												});
												await invalidateAll();
											}}
										></button>
									{:else}
										<span class="todo-dot" title="A TODO: line; delete it when done"></span>
									{/if}
									<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
									<a class="todo-text" href={`${storyPath}?scene=${todo.sceneId}`}>
										{todo.text}
										<span class="todo-scene">{todo.sceneTitle ?? 'Untitled scene'}</span>
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								</div>
							{/each}
							<div class="todo-hint">
								Write a line starting with TODO:, or select prose and press Ctrl+Alt+M.
							</div>
						</div>
					{/if}
					{#if data.selectedScene && data.inScene.length > 0}
						<div class="r-card">
							<h5>In this scene</h5>
							{#each data.inScene as entity (entity.id)}
								<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
								<a
									class="r-line"
									href={`${resolve('/stories/[id]/plan', { id: data.story.slug })}?entity=${entity.id}`}
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

	{#if focusMode.on}
		<div class="focus-controls">
			<ThemeToggle />
			<button
				class="icon-btn"
				type="button"
				title="Exit focus (Esc)"
				onclick={() => (focusMode.on = false)}
			>
				<Icon name="compress" />
			</button>
		</div>
	{/if}
</div>

{#if rowMenu}
	{@const target = rowMenu.target}
	<div class="row-menu" role="menu" style="left: {rowMenu.x}px; top: {rowMenu.y}px;">
		{#if target.kind === 'chapter'}
			<button
				class="row-menu-item"
				type="button"
				role="menuitem"
				onclick={() => {
					renamingChapterId = target.id;
					rowMenu = null;
				}}
			>
				<Icon name="pencil" size={13} /> Rename chapter
			</button>
			<form method="POST" action="?/moveChapter">
				<input type="hidden" name="chapterId" value={target.id} />
				<input type="hidden" name="direction" value="up" />
				{@render openSceneField()}
				<button
					class="row-menu-item turn-up"
					type="submit"
					role="menuitem"
					disabled={target.index === 0}
				>
					<Icon name="chevron" size={13} /> Move up
				</button>
			</form>
			<form method="POST" action="?/moveChapter">
				<input type="hidden" name="chapterId" value={target.id} />
				<input type="hidden" name="direction" value="down" />
				{@render openSceneField()}
				<button
					class="row-menu-item turn-down"
					type="submit"
					role="menuitem"
					disabled={target.index === data.chapters.length - 1}
				>
					<Icon name="chevron" size={13} /> Move down
				</button>
			</form>
			<form
				method="POST"
				action="?/deleteChapter"
				onsubmit={(e) => {
					if (!confirm('Delete this chapter? Its scenes move to Unfiled scenes.'))
						e.preventDefault();
				}}
			>
				<input type="hidden" name="chapterId" value={target.id} />
				{@render openSceneField()}
				<button class="row-menu-item danger" type="submit" role="menuitem">
					<Icon name="trash" size={13} /> Delete chapter
				</button>
			</form>
		{:else}
			<form method="POST" action="?/deleteScene">
				<input type="hidden" name="sceneId" value={target.id} />
				{@render openSceneField()}
				<button class="row-menu-item danger" type="submit" role="menuitem">
					<Icon name="trash" size={13} /> Delete scene
				</button>
			</form>
		{/if}
	</div>
{/if}

<style>
	/* The sidebar rows' right-click menu; same look as the editor's
	   selection menu. */
	.row-menu {
		position: fixed;
		z-index: 60;
		min-width: 170px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
	}
	.row-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		padding: 6px 7px;
		border-radius: 5px;
		/* Native context menus keep the arrow cursor; match them. */
		cursor: default;
	}
	.row-menu-item:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	.row-menu-item:disabled {
		color: var(--text-faint);
	}
	.row-menu-item.danger:hover:not(:disabled) {
		color: var(--danger, #c0564f);
	}
	.row-menu-item.turn-up :global(svg) {
		transform: rotate(-90deg);
	}
	.row-menu-item.turn-down :global(svg) {
		transform: rotate(90deg);
	}
	.chapter-row {
		width: 100%;
		border: 0;
		background: none;
		text-align: left;
	}
	/* The button reset above outranks the theme's hover by cascade order,
	   so restate it. */
	.chapter-row:hover {
		background: var(--bg-hover);
	}
	.chapter-row.as-label:hover {
		background: none;
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
	.todo-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 5px 0;
		border-bottom: 1px dashed var(--border);
	}
	.todo-check {
		width: 14px;
		height: 14px;
		margin-top: 2px;
		flex: none;
		border: 1.5px solid var(--cat-amber, #b8860b);
		border-radius: 4px;
		background: none;
		cursor: pointer;
	}
	.todo-check:hover {
		background: color-mix(in oklab, var(--cat-amber, #b8860b) 30%, transparent);
	}
	.todo-dot {
		width: 14px;
		height: 14px;
		margin-top: 2px;
		flex: none;
		border-radius: 99px;
		background: color-mix(in oklab, var(--cat-amber, #b8860b) 35%, transparent);
	}
	.todo-text {
		flex: 1;
		min-width: 0;
		text-decoration: none;
		color: var(--text);
		font-size: 12.5px;
		line-height: 1.45;
	}
	.todo-scene {
		display: block;
		color: var(--text-faint);
		font-size: 11.5px;
	}
	.todo-hint {
		color: var(--text-faint);
		font-size: 11.5px;
		padding-top: 8px;
	}
</style>
