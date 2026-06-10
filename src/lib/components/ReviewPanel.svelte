<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import ReviewCommentCard from './ReviewCommentCard.svelte';
	import ReviewSuggestionCard from './ReviewSuggestionCard.svelte';
	import {
		anchorPos,
		suggestionInFilter,
		threadInFilter,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '$lib/review-ui';

	// A pending comment or edit the reviewer is composing, anchored to a
	// selection (or to the whole scene when anchored is false).
	export type Composer = {
		sceneId: string;
		start: number;
		end: number;
		text: string;
		mode: 'comment' | 'suggest';
		anchored: boolean;
	};

	let {
		scene,
		threads,
		suggestions,
		filter,
		setFilter,
		focusedId,
		setFocused,
		role,
		canSuggest,
		composer,
		onCloseComposer,
		onStartSceneComment
	}: {
		scene: { id: string; bodyMd: string };
		threads: ReviewThread[];
		suggestions: ReviewSuggestion[];
		filter: ReviewFilter;
		setFilter: (f: ReviewFilter) => void;
		focusedId: string | null;
		setFocused: (id: string | null) => void;
		role: 'author' | 'guest';
		canSuggest: boolean;
		composer: Composer | null;
		onCloseComposer: () => void;
		onStartSceneComment: () => void;
	} = $props();

	const nComments = $derived(threads.filter((t) => t.resolvedAt === null).length);
	const nSugg = $derived(suggestions.filter((s) => s.status === 'pending').length);
	const nResolved = $derived(
		threads.filter((t) => t.resolvedAt !== null).length +
			suggestions.filter((s) => s.status !== 'pending').length
	);

	const FILTERS = $derived([
		{ id: 'all' as const, label: 'All', n: nComments + nSugg },
		{ id: 'comments' as const, label: 'Comments', n: nComments },
		{ id: 'suggestions' as const, label: 'Edits', n: nSugg },
		{ id: 'resolved' as const, label: 'Resolved', n: nResolved }
	]);

	// Threads and suggestions for this scene that pass the filter, in document
	// order. Each carries a sort position and, for threads, the live excerpt.
	const cards = $derived(
		[
			...threads
				.filter((t) => threadInFilter(t, filter))
				.map((t) => ({
					type: 'comment' as const,
					id: t.id,
					pos: anchorPos(t.anchor),
					thread: t,
					excerpt:
						t.anchor && !t.anchorLost ? scene.bodyMd.slice(t.anchor.start, t.anchor.end) : null
				})),
			...suggestions
				.filter((s) => suggestionInFilter(s, filter))
				.map((s) => ({
					type: 'suggestion' as const,
					id: s.id,
					pos: anchorPos(s.anchor),
					suggestion: s
				}))
		].sort((a, b) => a.pos - b.pos)
	);

	let scrollEl: HTMLElement | undefined = $state();
	// Bring the focused card into view when focus arrives from the centre or nav.
	$effect(() => {
		const id = focusedId;
		if (!id || !scrollEl) return;
		const el = scrollEl.querySelector<HTMLElement>(`#rv-card-${CSS.escape(id)}`);
		if (!el) return;
		const er = el.getBoundingClientRect();
		const sr = scrollEl.getBoundingClientRect();
		if (er.top < sr.top + 8 || er.bottom > sr.bottom - 8)
			scrollEl.scrollTop += er.top - sr.top - 16;
	});

	let composerBody = $state('');
	// Reset the draft whenever a fresh composer opens.
	$effect(() => {
		if (composer) composerBody = composer.mode === 'suggest' ? composer.text : '';
	});
	const canSave = $derived(
		composer?.mode === 'suggest'
			? composerBody.trim().length > 0 && composerBody.trim() !== composer.text.trim()
			: composerBody.trim().length > 0
	);
</script>

<div class="review-panel">
	<div class="rv-panel-head">
		<div class="rv-panel-title">
			<span>Review</span>
			<button class="rv-scene-comment" type="button" onclick={onStartSceneComment}>
				<Icon name="comment-plus" size={13} /> Whole scene
			</button>
		</div>
		<div class="rv-filters">
			{#each FILTERS as f (f.id)}
				<button
					class="rv-filter"
					class:active={filter === f.id}
					type="button"
					onclick={() => setFilter(f.id)}
				>
					{f.label}<span class="rv-filter-n">{f.n}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="rv-panel-scroll" bind:this={scrollEl}>
		{#if composer && composer.sceneId === scene.id}
			<form
				method="POST"
				action={composer.mode === 'suggest' ? '?/suggest' : '?/comment'}
				class="rv-card is-draft"
				style="--auth: var(--accent);"
				use:enhance={() =>
					({ update }) => {
						onCloseComposer();
						return update();
					}}
			>
				<div class="rv-card-top">
					<div class="rv-who">
						<div class="rv-who-name">
							{composer.mode === 'suggest' ? 'New suggestion' : 'New comment'}
						</div>
						<div class="rv-when">
							{composer.anchored ? 'On the selected passage' : 'On the whole scene'}
						</div>
					</div>
					<span class="rv-type-pill">
						{#if composer.mode === 'suggest'}<Icon name="suggest" size={11} /> Edit{:else}<Icon
								name="comment"
								size={11}
							/> Comment{/if}
					</span>
				</div>

				<input type="hidden" name="sceneId" value={scene.id} />
				{#if composer.anchored}
					<input type="hidden" name="start" value={composer.start} />
					<input type="hidden" name="end" value={composer.end} />
				{/if}

				{#if composer.mode === 'suggest'}
					<div class="rv-draft-from">
						<span class="rv-draft-k">Original</span>
						<span class="rv-draft-orig">"{composer.text}"</span>
					</div>
					<span class="rv-draft-k rv-draft-to">Suggest instead</span>
					<textarea
						name="replacement"
						class="rv-draft-input"
						aria-label="Suggested text"
						bind:value={composerBody}
					></textarea>
					<div class="rv-draft-help">
						The original stays struck through; your replacement is offered for the author to accept
						or reject.
					</div>
				{:else}
					{#if composer.anchored}
						<div class="rv-card-quote" style="--auth: var(--accent);">"{composer.text}"</div>
					{/if}
					<textarea
						name="body"
						class="rv-draft-input"
						placeholder="Add your comment..."
						aria-label="Your comment"
						bind:value={composerBody}
					></textarea>
				{/if}

				<div class="rv-actions">
					<button class="rv-btn solid" type="submit" disabled={!canSave}>
						{composer.mode === 'suggest' ? 'Save suggestion' : 'Comment'}
					</button>
					<button class="rv-btn ghost" type="button" onclick={onCloseComposer}>Cancel</button>
				</div>
			</form>
		{/if}

		{#if cards.length === 0 && !composer}
			<div class="rv-panel-empty">
				<Icon name="check-circle" size={26} />
				<div>
					{#if filter === 'resolved'}
						Nothing resolved in this scene yet.
					{:else}
						No open notes here. Select text in the manuscript to leave a comment{canSuggest
							? ' or suggest an edit'
							: ''}.
					{/if}
				</div>
			</div>
		{/if}

		{#each cards as card (card.id)}
			{#if card.type === 'comment'}
				<ReviewCommentCard
					thread={card.thread}
					excerpt={card.excerpt}
					{role}
					focused={focusedId === card.id}
					onFocus={setFocused}
				/>
			{:else}
				<ReviewSuggestionCard
					suggestion={card.suggestion}
					{role}
					focused={focusedId === card.id}
					onFocus={setFocused}
				/>
			{/if}
		{/each}
	</div>
</div>
