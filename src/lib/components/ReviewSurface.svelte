<script lang="ts">
	import Icon from './Icon.svelte';
	import EntityQuickCard from './EntityQuickCard.svelte';
	import { detectMentions, type MentionTarget } from '$lib/mention-detect';
	import type { MentionEntity } from '$lib/editor-mentions';
	import {
		reviewProse,
		threadAuthor,
		suggestionAuthor,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '$lib/review-ui';

	let {
		scene,
		chapterTitle,
		threads,
		suggestions,
		filter,
		focusedId,
		setFocused,
		canSuggest,
		entities,
		mentionMembers,
		mentionPins,
		entityHref,
		onStartComment,
		onStartSuggest
	}: {
		scene: { title: string | null; bodyMd: string };
		chapterTitle: string;
		threads: ReviewThread[];
		suggestions: ReviewSuggestion[];
		filter: ReviewFilter;
		focusedId: string | null;
		setFocused: (id: string | null) => void;
		canSuggest: boolean;
		entities: MentionEntity[];
		mentionMembers: string[];
		mentionPins: Record<string, string>;
		// Where "Open full details" points; absent for reviewers, who never reach
		// the full entity.
		entityHref: ((entity: MentionEntity) => string) | null;
		onStartComment: (sel: { start: number; end: number; text: string }) => void;
		onStartSuggest: (sel: { start: number; end: number; text: string }) => void;
	} = $props();

	const entityById = $derived(new Map(entities.map((entity) => [entity.id, entity])));
	const targets = $derived<MentionTarget[]>(
		entities.map((entity) => ({
			id: entity.id,
			type: entity.type,
			names: [entity.name, ...entity.aliases]
		}))
	);
	const mentions = $derived(
		detectMentions(scene.bodyMd, targets, {
			storyMembers: new Set(mentionMembers),
			pins: new Map(Object.entries(mentionPins))
		})
	);

	const prose = $derived(
		reviewProse(
			scene.bodyMd,
			threads.map((t) => ({
				id: t.id,
				anchor: t.resolvedAt ? null : t.anchor,
				author: threadAuthor(t)
			})),
			suggestions.map((s) => ({
				id: s.id,
				anchor: s.anchor,
				status: s.status,
				original: s.original,
				replacement: s.replacement,
				author: suggestionAuthor(s)
			})),
			filter,
			mentions
		)
	);

	// The quick card for a mention, opened by mouse or keyboard.
	let card = $state<{ entity: MentionEntity; x: number; y: number } | null>(null);
	let popEl = $state<HTMLElement>();
	function showCard(entityId: string, x: number, y: number) {
		const entity = entityById.get(entityId);
		if (!entity) return;
		card = { entity, x, y };
	}
	function openCardAtPointer(entityId: string, event: MouseEvent) {
		event.stopPropagation();
		showCard(entityId, event.clientX, event.clientY);
	}
	// Enter or Space on a focused mention opens its card under the word.
	function openCardFromKey(entityId: string, event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
		showCard(entityId, r.left + r.width / 2, r.bottom);
	}
	$effect(() => {
		if (!card) return;
		function dismiss(e: Event) {
			if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
			if (e.type === 'mousedown' && (e.target as HTMLElement).closest('.rv-cardpop')) return;
			card = null;
		}
		document.addEventListener('mousedown', dismiss);
		document.addEventListener('keydown', dismiss);
		return () => {
			document.removeEventListener('mousedown', dismiss);
			document.removeEventListener('keydown', dismiss);
		};
	});
	// Keep the card on screen: centre it on the point, nudge it back from either
	// side it would overflow, and flip it above the word when it would spill off
	// the bottom.
	$effect(() => {
		if (!card || !popEl) return;
		void card.x;
		void card.y;
		popEl.style.transform = 'translate(-50%, 10px)';
		const r = popEl.getBoundingClientRect();
		const m = 8;
		let dx = 0;
		if (r.right > window.innerWidth - m) dx = window.innerWidth - m - r.right;
		if (r.left + dx < m) dx = m - r.left;
		const ty = r.bottom > window.innerHeight - m ? -(r.height + 10) : 10;
		popEl.style.transform = `translate(calc(-50% + ${dx}px), ${ty}px)`;
	});

	const openComments = $derived(threads.filter((t) => t.resolvedAt === null).length);
	const openSugg = $derived(suggestions.filter((s) => s.status === 'pending').length);

	let docEl: HTMLElement | undefined = $state();
	let proseEl: HTMLElement | undefined = $state();
	let scrollEl: HTMLElement | undefined = $state();

	// ---- margin rail markers, measured from the rendered marks ----
	type Marker = { id: string; kind: string; color: string; top: number };
	let markers = $state<Marker[]>([]);

	function measure() {
		if (!docEl) return;
		const nodes = docEl.querySelectorAll<HTMLElement>('.rv-mark');
		const raw: Marker[] = [];
		for (const node of nodes) {
			const id = node.dataset.rid;
			if (!id) continue;
			raw.push({
				id,
				kind: node.dataset.kind ?? 'comment',
				color: node.style.getPropertyValue('--auth') || 'var(--accent)',
				top: node.offsetTop
			});
		}
		raw.sort((a, b) => a.top - b.top);
		// Nudge markers apart so stacked notes stay clickable.
		let last = -999;
		for (const m of raw) {
			if (m.top < last + 32) m.top = last + 32;
			last = m.top;
		}
		markers = raw;
	}

	$effect(() => {
		// Re-measure when the prose or focus change.
		void prose;
		void focusedId;
		measure();
		const ro = new ResizeObserver(() => measure());
		if (docEl) ro.observe(docEl);
		window.addEventListener('resize', measure);
		// Re-measure once the web fonts have settled.
		const t = setTimeout(measure, 300);
		return () => {
			ro.disconnect();
			window.removeEventListener('resize', measure);
			clearTimeout(t);
		};
	});

	// ---- scroll the focused mark into view ----
	$effect(() => {
		const id = focusedId;
		if (!id || !docEl || !scrollEl) return;
		const el = docEl.querySelector<HTMLElement>(`[data-rid="${CSS.escape(id)}"]`);
		if (!el) {
			// A whole-scene comment has no inline mark; show the top of the scene.
			const whole =
				threads.some((t) => t.id === id && !t.anchor) ||
				suggestions.some((s) => s.id === id && !s.anchor);
			if (whole) scrollEl.scrollTop = 0;
			return;
		}
		const er = el.getBoundingClientRect();
		const sr = scrollEl.getBoundingClientRect();
		if (er.top < sr.top + 50 || er.bottom > sr.bottom - 50) {
			scrollEl.scrollTop += er.top - sr.top - sr.height * 0.34;
		}
	});

	// ---- selection -> floating toolbar ----
	let sel = $state<{ left: number; top: number; start: number; end: number; text: string } | null>(
		null
	);

	// Character offset of a DOM point within the scene text, skipping any text
	// that is shown but not part of the manuscript (a suggestion's replacement).
	// Walks the prose only, so the header and rail never shift the count.
	function textOffset(target: Node, offset: number): number {
		if (!proseEl) return 0;
		const walker = document.createTreeWalker(proseEl, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) =>
				node.parentElement?.closest('[data-rv-virtual]')
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT
		});
		let total = 0;
		let node = walker.nextNode();
		while (node) {
			if (node === target) return total + offset;
			total += node.textContent?.length ?? 0;
			node = walker.nextNode();
		}
		return total;
	}

	function onMouseUp() {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount || !docEl || !proseEl) {
			sel = null;
			return;
		}
		const range = selection.getRangeAt(0);
		if (!proseEl.contains(range.startContainer) || !proseEl.contains(range.endContainer)) {
			sel = null;
			return;
		}
		const start = textOffset(range.startContainer, range.startOffset);
		const end = textOffset(range.endContainer, range.endOffset);
		if (end <= start) {
			sel = null;
			return;
		}
		const rects = range.getClientRects();
		const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
		const dr = docEl.getBoundingClientRect();
		sel = {
			left: rect.left + rect.width / 2 - dr.left,
			top: rect.top - dr.top,
			start,
			end,
			text: scene.bodyMd.slice(start, end)
		};
	}

	function clearSelection() {
		window.getSelection()?.removeAllRanges();
		sel = null;
	}

	function startComment() {
		if (sel) onStartComment({ start: sel.start, end: sel.end, text: sel.text });
		clearSelection();
	}
	function startSuggest() {
		if (sel) onStartSuggest({ start: sel.start, end: sel.end, text: sel.text });
		clearSelection();
	}

	$effect(() => {
		function onDown(e: MouseEvent) {
			if (sel && !(e.target as HTMLElement).closest('.rv-seltool')) {
				const s = window.getSelection();
				if (!s || s.isCollapsed) sel = null;
			}
		}
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	});
</script>

<div class="editor-scroll review-scroll" bind:this={scrollEl} onscroll={() => (card = null)}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="review-doc" bind:this={docEl} onmouseup={onMouseUp}>
		<div class="review-head">
			<div class="review-kicker">{chapterTitle} - review</div>
			<h1 class="review-title">{scene.title ?? 'Untitled scene'}</h1>
			<div class="review-subline">
				{#if openComments + openSugg === 0}
					No open review activity in this scene.
				{:else}
					{#if openComments > 0}
						<span class="rv-sub-chip">
							<Icon name="comment" size={13} />
							{openComments}
							{openComments === 1 ? 'comment' : 'comments'}
						</span>
					{/if}
					{#if openSugg > 0}
						<span class="rv-sub-chip">
							<Icon name="suggest" size={13} />
							{openSugg}
							{openSugg === 1 ? 'suggestion' : 'suggestions'}
						</span>
					{/if}
				{/if}
			</div>
		</div>

		{#if scene.bodyMd.trim() === ''}
			<div class="rv-empty-scene">
				This scene has not been drafted yet, so there is nothing to review.
			</div>
		{:else}
			<div class="review-prose" bind:this={proseEl}>
				{#each prose as run, i (i)}{#if run.kind === 'plain'}{run.text}{:else if run.kind === 'mention'}<span
							class="ref-word"
							data-entity-id={run.entityId}
							role="button"
							tabindex="0"
							onclick={(e) => openCardAtPointer(run.entityId, e)}
							onkeydown={(e) => openCardFromKey(run.entityId, e)}>{run.text}</span
						>{:else if run.kind === 'comment'}<span
							class="rv-mark rv-comment"
							class:is-focused={focusedId === run.id}
							style="--auth: {run.color};"
							data-rid={run.id}
							data-kind="comment"
							role="button"
							tabindex="-1"
							onclick={(e) => {
								e.stopPropagation();
								setFocused(run.id);
							}}
							onkeydown={() => {}}>{run.text}</span
						>{:else if run.kind === 'del'}<span
							class="rv-mark rv-del"
							class:is-focused={focusedId === run.id}
							style="--auth: {run.color};"
							data-rid={run.id}
							data-kind="del"
							role="button"
							tabindex="-1"
							onclick={(e) => {
								e.stopPropagation();
								setFocused(run.id);
							}}
							onkeydown={() => {}}><del class="rv-del-t">{run.text}</del></span
						>{:else if run.kind === 'ins'}<span
							class="rv-mark rv-ins"
							class:is-focused={focusedId === run.id}
							style="--auth: {run.color};"
							data-rid={run.id}
							data-kind="ins"
							role="button"
							tabindex="-1"
							onclick={(e) => {
								e.stopPropagation();
								setFocused(run.id);
							}}
							onkeydown={() => {}}><ins class="rv-ins-t" data-rv-virtual>{run.text}</ins></span
						>{:else}<span
							class="rv-mark rv-replace"
							class:is-focused={focusedId === run.id}
							style="--auth: {run.color};"
							data-rid={run.id}
							data-kind="replace"
							role="button"
							tabindex="-1"
							onclick={(e) => {
								e.stopPropagation();
								setFocused(run.id);
							}}
							onkeydown={() => {}}
							><del class="rv-del-t">{run.before}</del><ins class="rv-ins-t" data-rv-virtual
								>{run.after}</ins
							></span
						>{/if}{/each}
			</div>
		{/if}

		<div class="review-rail" aria-hidden="true">
			{#each markers as marker (marker.id)}
				<button
					class="rv-marker"
					class:is-focused={focusedId === marker.id}
					style="top: {marker.top}px; --auth: {marker.color};"
					type="button"
					onclick={() => setFocused(marker.id)}
					title="Jump to this note"
				>
					<Icon name={marker.kind === 'comment' ? 'comment' : 'suggest'} size={13} />
				</button>
			{/each}
		</div>

		{#if sel}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="rv-seltool"
				style="left: {sel.left}px; top: {sel.top}px;"
				onmousedown={(e) => e.preventDefault()}
			>
				<button type="button" onclick={startComment}>
					<Icon name="comment-plus" size={15} /> Comment
				</button>
				{#if canSuggest}
					<span class="rv-seltool-sep"></span>
					<button type="button" onclick={startSuggest}>
						<Icon name="suggest" size={15} /> Suggest edit
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

{#if card}
	<div class="rv-cardpop" bind:this={popEl} style="left: {card.x}px; top: {card.y}px;">
		<EntityQuickCard entity={card.entity} href={entityHref ? entityHref(card.entity) : null} />
	</div>
{/if}
