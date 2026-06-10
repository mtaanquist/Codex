<script lang="ts">
	import Icon from './Icon.svelte';
	import {
		anchorPos,
		authorColor,
		suggestionAuthor,
		suggestionInFilter,
		suggestionSnippet,
		threadAuthor,
		threadInFilter,
		type AuthorRef,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '$lib/review-ui';

	let {
		scenes,
		threads,
		suggestions,
		filter,
		setFilter,
		focusedId,
		selectedSceneId,
		onSelect,
		query
	}: {
		// All scenes in document order, with their chapter label.
		scenes: { id: string; title: string | null; chapterTitle: string }[];
		threads: ReviewThread[];
		suggestions: ReviewSuggestion[];
		filter: ReviewFilter;
		setFilter: (f: ReviewFilter) => void;
		focusedId: string | null;
		selectedSceneId: string;
		onSelect: (sceneId: string, itemId: string) => void;
		query: string;
	} = $props();

	const FILTERS: { id: ReviewFilter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'comments', label: 'Comments' },
		{ id: 'suggestions', label: 'Edits' },
		{ id: 'resolved', label: 'Resolved' }
	];

	type Item = {
		id: string;
		sceneId: string;
		type: 'comment' | 'suggestion';
		author: AuthorRef;
		snippet: string;
		by: string;
		pos: number;
	};

	const totalOpen = $derived(
		threads.filter((t) => t.resolvedAt === null).length +
			suggestions.filter((s) => s.status === 'pending').length
	);

	const items = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list: Item[] = [];
		for (const t of threads) {
			if (!threadInFilter(t, filter)) continue;
			const author = threadAuthor(t);
			const body = t.comments[0]?.body ?? '';
			const snippet = body.trim().slice(0, 70) || 'Comment';
			const status = t.resolvedAt ? ' - resolved' : '';
			list.push({
				id: t.id,
				sceneId: t.sceneId,
				type: 'comment',
				author,
				snippet,
				by: author.name + status,
				pos: anchorPos(t.anchor)
			});
		}
		for (const s of suggestions) {
			if (!suggestionInFilter(s, filter)) continue;
			const author = suggestionAuthor(s);
			const status = s.status !== 'pending' ? ` - ${s.status}` : '';
			list.push({
				id: s.id,
				sceneId: s.sceneId,
				type: 'suggestion',
				author,
				snippet: suggestionSnippet(s),
				by: author.name + status,
				pos: anchorPos(s.anchor)
			});
		}
		const filtered = q
			? list.filter((it) => (it.snippet + ' ' + it.by).toLowerCase().includes(q))
			: list;
		return filtered.sort((a, b) => a.pos - b.pos);
	});

	// Group items under their scene, keeping the scenes in document order.
	const groups = $derived.by(() =>
		scenes
			.map((scene) => ({ scene, list: items.filter((it) => it.sceneId === scene.id) }))
			.filter((group) => group.list.length > 0)
	);
</script>

<div class="review-nav">
	<div class="rv-nav-stat">
		<span class="rv-nav-stat-n">{totalOpen}</span>
		<span class="rv-nav-stat-l"
			>open {totalOpen === 1 ? 'item' : 'items'} across the manuscript</span
		>
	</div>

	<div class="rv-nav-filters">
		{#each FILTERS as f (f.id)}
			<button
				class="rv-nav-filter"
				class:active={filter === f.id}
				type="button"
				onclick={() => setFilter(f.id)}
			>
				{f.label}
			</button>
		{/each}
	</div>

	{#if groups.length === 0}
		<div class="rv-nav-empty">
			{#if query.trim()}
				No review items match "{query}".
			{:else}
				Nothing here. Switch filters, or open a scene and select text to add a note.
			{/if}
		</div>
	{/if}

	{#each groups as group (group.scene.id)}
		<div class="rv-nav-group">
			<div class="rv-nav-scene" class:active={group.scene.id === selectedSceneId}>
				<span class="rv-nav-scene-name">{group.scene.title ?? 'Untitled scene'}</span>
				<span class="rv-nav-scene-meta">{group.scene.chapterTitle}</span>
			</div>
			{#each group.list as it (it.id)}
				<button
					class="rv-nav-row"
					class:active={focusedId === it.id}
					type="button"
					onclick={() => onSelect(it.sceneId, it.id)}
				>
					<span class="rv-nav-ic" style="--auth: {authorColor(it.author)};">
						<Icon name={it.type === 'comment' ? 'comment' : 'suggest'} size={13} />
					</span>
					<span class="rv-nav-text">
						<span class="rv-nav-snip">{it.snippet}</span>
						<span class="rv-nav-by">{it.by}</span>
					</span>
				</button>
			{/each}
		</div>
	{/each}
</div>
