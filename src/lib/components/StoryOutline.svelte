<script lang="ts">
	import type { Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { goto, invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import { dismiss } from '$lib/dismiss';
	import { filterChapter, filterOrphanScenes } from '$lib/outline-filter';
	import type { RowMenuTarget } from './StoryRowMenu.svelte';

	// The chapter and scene tree shared by the Write and Review sidebars: the book
	// header, the tree with drag-to-reorder and right-click menus, and the trash.
	// Write renders it with link rows that navigate; Review passes onSelectScene
	// so rows select in place, a custom sceneMeta badge, and canManage=false for
	// guests. The page owns the row menu and the search query; selection rides the
	// URL on Write and the caller's state on Review.
	type OutlineScene = {
		id: string;
		chapterId: string | null;
		title: string | null;
		status?: string | null;
		wordCount?: number;
	};

	let {
		story,
		universeName,
		storySiblings = [],
		chapters,
		scenes,
		trashedScenes = [],
		selectedSceneId,
		viewStory = false,
		storyPath = '',
		query,
		mergeSelection = new SvelteSet<string>(),
		renamingChapterId = $bindable(null),
		onOpenRowMenu = () => {},
		canManage = true,
		onSelectScene = null,
		sceneMeta = null
	}: {
		story: { id: string; title: string };
		universeName: string;
		storySiblings?: {
			id: string;
			slug: string;
			title: string;
			chapters: number;
			words: number;
		}[];
		chapters: { id: string; title: string | null }[];
		scenes: OutlineScene[];
		trashedScenes?: { id: string; title: string | null; wordCount: number }[];
		// Sidebar actions reload the page; carrying the open scene keeps it open.
		selectedSceneId: string | null;
		// In the continuous story view the rows jump by anchor, not navigation.
		viewStory?: boolean;
		storyPath?: string;
		query: string;
		// Scenes picked for merging, shared with the row menu.
		mergeSelection?: SvelteSet<string>;
		// Which chapter shows its inline rename field; the row menu sets it.
		renamingChapterId?: string | null;
		onOpenRowMenu?: (event: MouseEvent, target: RowMenuTarget) => void;
		// Review reuses this sidebar read-or-manage. canManage=false (the guest
		// reviewer) hides the menu, drag, create, and trash. onSelectScene makes a
		// row select in place instead of navigating. sceneMeta replaces the word
		// count with a review-activity badge. None of these change the Write side.
		canManage?: boolean;
		onSelectScene?: ((sceneId: string) => void) | null;
		sceneMeta?: Snippet<[OutlineScene]> | null;
	} = $props();

	const orphanScenes = $derived(scenes.filter((scene) => scene.chapterId === null));

	// Chapters start expanded; collapsing is per-visit state.
	let collapsed = new SvelteSet<string>();

	// The deleted-scenes list starts closed; its count shows in the header.
	let trashOpen = $state(false);

	// The book switcher's menu, toggled from the sidebar header.
	let storyMenuOpen = $state(false);

	function chapterScenes(chapterId: string) {
		return scenes.filter((scene) => scene.chapterId === chapterId);
	}

	const visibleOrphans = $derived(filterOrphanScenes(query, orphanScenes));
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
		const chapterLists = chapters.map((chapter) => ({
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
		await fetch(`/api/stories/${story.id}/scene-order`, {
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

{#snippet openSceneField()}
	{#if selectedSceneId}
		<input type="hidden" name="openSceneId" value={selectedSceneId} />
	{/if}
{/snippet}

{#snippet sceneMetaBadge(scene: OutlineScene)}
	{#if sceneMeta}
		{@render sceneMeta(scene)}
	{:else if (scene.wordCount ?? 0) > 0}
		<span class="scene-words">{words(scene.wordCount ?? 0)}</span>
	{/if}
{/snippet}

{#snippet sceneRow(
	scene: OutlineScene,
	chapterId: string | null,
	index: number,
	draggable: boolean
)}
	{#if onSelectScene}
		<button
			class="scene-row"
			class:active={scene.id === selectedSceneId}
			class:merge-selected={mergeSelection.has(scene.id)}
			type="button"
			draggable={canManage && draggable}
			oncontextmenu={canManage
				? (e) => onOpenRowMenu(e, { kind: 'scene', id: scene.id })
				: undefined}
			onclick={() => onSelectScene?.(scene.id)}
			ondragstart={canManage
				? (e) => {
						draggingSceneId = scene.id;
						e.dataTransfer?.setData('text/plain', scene.id);
					}
				: undefined}
			ondragover={canManage ? (e) => overScene(e, chapterId, index) : undefined}
			ondrop={canManage ? commitDrop : undefined}
			ondragend={canManage ? endDrag : undefined}
		>
			<span class="scene-status st-{scene.status ?? 'draft'}" title={scene.status ?? 'draft'}
			></span>
			<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
			{@render sceneMetaBadge(scene)}
		</button>
	{:else}
		<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
		<a
			class="scene-row"
			class:active={scene.id === selectedSceneId}
			class:merge-selected={mergeSelection.has(scene.id)}
			href={viewStory ? `#scene-${scene.id}` : `${storyPath}?scene=${scene.id}`}
			{draggable}
			oncontextmenu={(e) => onOpenRowMenu(e, { kind: 'scene', id: scene.id })}
			ondragstart={(e) => {
				draggingSceneId = scene.id;
				e.dataTransfer?.setData('text/plain', scene.id);
			}}
			ondragover={(e) => overScene(e, chapterId, index)}
			ondrop={commitDrop}
			ondragend={endDrag}
		>
			<span class="scene-status st-{scene.status ?? 'draft'}" title={scene.status ?? 'draft'}
			></span>
			<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
			{@render sceneMetaBadge(scene)}
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}
{/snippet}

<div class="outline" class:selectable={onSelectScene} class:manageable={canManage}>
	{#if onSelectScene}
		<!-- Review shows a static book label; the switcher would jump to another
		     story's editor, which makes no sense mid-review. -->
		<div class="outline-head">
			<span class="story-switch as-label">
				<span class="story-book"><Icon name="book" size={15} /></span>
				<span class="story-id">
					<span class="story-title">{story.title}</span>
					{#if universeName}<span class="story-universe">{universeName}</span>{/if}
				</span>
			</span>
		</div>
	{:else}
		<div
			class="outline-head"
			use:dismiss={{ enabled: storyMenuOpen, close: () => (storyMenuOpen = false) }}
		>
			<!-- The book switcher: with more than one story in the
				     universe, the header opens a menu to jump between them. -->
			<button
				class="story-switch"
				type="button"
				disabled={storySiblings.length < 2}
				onclick={() => (storyMenuOpen = !storyMenuOpen)}
			>
				<span class="story-book"><Icon name="book" size={15} /></span>
				<span class="story-id">
					<span class="story-title">{story.title}</span>
					<span class="story-universe">{universeName}</span>
				</span>
				{#if storySiblings.length > 1}
					<span class="story-caret" class:open={storyMenuOpen}>
						<Icon name="chevron" size={13} />
					</span>
				{/if}
			</button>
			{#if storyMenuOpen}
				<div class="story-menu">
					{#each storySiblings as sibling (sibling.id)}
						<button
							type="button"
							class:active={sibling.id === story.id}
							onclick={async () => {
								storyMenuOpen = false;
								if (sibling.id !== story.id) {
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
	{/if}
	<div class="chapters">
		{#each chapters as chapter, index (chapter.id)}
			{@const filtered = filterChapter(
				query,
				chapter.title,
				`Chapter ${index + 1}`,
				chapterScenes(chapter.id)
			)}
			{@const list = filtered.scenes}
			{@const open = query !== '' || !collapsed.has(chapter.id)}
			{#if filtered.visible}
				<div class="chapter">
					{#if renamingChapterId === chapter.id}
						<form
							class="chapter-rename"
							method="POST"
							action="?/renameChapter"
							use:enhance={() =>
								async ({ update }) => {
									await update();
									renamingChapterId = null;
								}}
						>
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
							oncontextmenu={canManage
								? (e) => onOpenRowMenu(e, { kind: 'chapter', id: chapter.id, index })
								: undefined}
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
								{@render sceneRow(scene, chapter.id, si, true)}
							{/each}
							{#if dropTarget?.chapterId === chapter.id && dropTarget.index === list.length && open}
								<div class="drop-line scene"></div>
							{/if}
							{#if canManage && query === ''}
								<form method="POST" action="?/createScene" use:enhance>
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
						{@render sceneRow(scene, null, si, query === '')}
					{/each}
					{#if dropTarget?.chapterId === null && dropTarget.index === visibleOrphans.length}
						<div class="drop-line scene"></div>
					{/if}
				</div>
			</div>
		{/if}
		{#if query !== '' && visibleOrphans.length === 0 && !chapters.some((chapter, index) => filterChapter(query, chapter.title, `Chapter ${index + 1}`, chapterScenes(chapter.id)).visible)}
			<div class="search-empty">No chapters or scenes match.</div>
		{/if}
		{#if canManage && query === ''}
			<form method="POST" action="?/createChapter" use:enhance>
				<button class="outline-add" type="submit">
					<Icon name="plus" size={13} /> New chapter
				</button>
			</form>
		{/if}
		{#if canManage && query === '' && trashedScenes.length > 0}
			<div class="chapter trash">
				<button class="chapter-row" type="button" onclick={() => (trashOpen = !trashOpen)}>
					<span class="tw" class:open={trashOpen}><Icon name="chevron" size={12} /></span>
					<span class="chapter-name">Deleted scenes</span>
					<span class="chapter-meta">{trashedScenes.length}</span>
				</button>
				{#if trashOpen}
					<div class="scenes">
						{#each trashedScenes as scene (scene.id)}
							<div class="trash-row">
								<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
								{#if scene.wordCount > 0}
									<span class="scene-words">{words(scene.wordCount)}</span>
								{/if}
								<form method="POST" action="?/restoreScene" use:enhance>
									<input type="hidden" name="sceneId" value={scene.id} />
									<button class="tool-btn" type="submit" title="Restore scene">
										<Icon name="restore" size={12} />
									</button>
								</form>
								<form
									method="POST"
									action="?/destroyScene"
									onsubmit={(e) => {
										if (!confirm('Delete this scene forever? It cannot be restored after this.'))
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

<style>
	.scene-row.merge-selected {
		box-shadow: inset 0 0 0 1.5px var(--accent-line);
		border-radius: 6px;
	}
	.chapter-row.as-label:hover {
		background: none;
	}
	/* A read-only review sidebar (the guest) selects but cannot drag, so the
	   default grab cursor would mislead; the author keeps grab, since the author
	   can reorder. */
	.outline.selectable:not(.manageable) .scene-row {
		cursor: pointer;
	}
</style>
