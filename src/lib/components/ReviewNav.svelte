<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import Icon from './Icon.svelte';
	import { filterChapter, filterOrphanScenes } from '$lib/outline-filter';
	import {
		suggestionInFilter,
		threadInFilter,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '$lib/review-ui';

	let {
		chapters,
		scenes,
		threads,
		suggestions,
		filter,
		selectedSceneId,
		onSelect,
		query
	}: {
		chapters: { id: string; title: string | null }[];
		// All scenes, tagged with their chapter, in document order.
		scenes: {
			id: string;
			chapterId: string | null;
			title: string | null;
			status?: string | null;
		}[];
		threads: ReviewThread[];
		suggestions: ReviewSuggestion[];
		filter: ReviewFilter;
		selectedSceneId: string;
		onSelect: (sceneId: string) => void;
		query: string;
	} = $props();

	// Review items per scene, honoring the active filter, counted the same way
	// the right panel lists them so the badges and the panel always agree.
	const countByScene = $derived.by(() => {
		const m = new SvelteMap<string, number>();
		for (const t of threads) {
			if (threadInFilter(t, filter)) m.set(t.sceneId, (m.get(t.sceneId) ?? 0) + 1);
		}
		for (const s of suggestions) {
			if (suggestionInFilter(s, filter)) m.set(s.sceneId, (m.get(s.sceneId) ?? 0) + 1);
		}
		return m;
	});
	// Collapsed chapters; a search forces every match open.
	let collapsed = new SvelteSet<string>();

	const q = $derived(query.trim().toLowerCase());

	function scenesIn(chapterId: string | null) {
		return scenes.filter((s) => s.chapterId === chapterId);
	}

	// Chapters (and the unfiled bucket) with their visible scenes, dropping any
	// that the search hides entirely.
	const groups = $derived.by(() => {
		const out: {
			id: string | null;
			label: string;
			scenes: typeof scenes;
			total: number;
		}[] = [];
		chapters.forEach((chapter, i) => {
			const fallback = `Chapter ${i + 1}`;
			const all = scenesIn(chapter.id);
			const filtered = filterChapter(q, chapter.title, fallback, all);
			if (!filtered.visible) return;
			out.push({
				id: chapter.id,
				label: chapter.title ?? fallback,
				scenes: filtered.scenes,
				total: all.length
			});
		});
		const orphans = scenesIn(null);
		const orphanList = filterOrphanScenes(q, orphans);
		if (orphanList.length > 0) {
			out.push({
				id: null,
				label: 'Unfiled scenes',
				scenes: orphanList,
				total: orphans.length
			});
		}
		return out;
	});

	function toggle(id: string | null) {
		if (id === null) return;
		if (collapsed.has(id)) collapsed.delete(id);
		else collapsed.add(id);
	}
</script>

<div class="review-outline">
	<div class="outline">
		{#if groups.length === 0}
			<div class="search-empty">
				{#if q}
					No chapters or scenes match.
				{:else}
					This story has no scenes yet.
				{/if}
			</div>
		{/if}

		{#each groups as group (group.id ?? 'unfiled')}
			{@const open = q !== '' || group.id === null || !collapsed.has(group.id)}
			<div class="chapter">
				{#if group.id === null}
					<span class="chapter-row as-label">
						<span class="chapter-name">{group.label}</span>
						<span class="chapter-meta">{group.total}</span>
					</span>
				{:else}
					<button class="chapter-row" type="button" onclick={() => toggle(group.id)}>
						<span class="tw" class:open><Icon name="chevron" size={12} /></span>
						<span class="chapter-name">{group.label}</span>
						<span class="chapter-meta">{group.total}</span>
					</button>
				{/if}

				{#if open}
					<div class="scenes">
						{#each group.scenes as scene (scene.id)}
							{@const n = countByScene.get(scene.id) ?? 0}
							<button
								class="scene-row"
								class:active={scene.id === selectedSceneId}
								type="button"
								onclick={() => onSelect(scene.id)}
							>
								<span
									class="scene-status st-{scene.status ?? 'draft'}"
									title={scene.status ?? 'draft'}
								></span>
								<span class="scene-name">{scene.title ?? 'Untitled scene'}</span>
								{#if n > 0}<span class="scene-count">{n}</span>{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
