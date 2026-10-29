<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import Icon from './Icon.svelte';
	import FormStatus from './FormStatus.svelte';
	import { SCENE_STATUSES, SCENE_STATUS_LABELS, type SceneStatus } from '$lib/scene-status';
	import { formatNumber, pluralSuffix } from '$lib/format';

	// The story's scenes as cards in status lanes. Drag a card to a lane, or
	// use the card's arrows, to move it along the ladder; story order within
	// a lane is untouched.
	let {
		scenes,
		chapters,
		todoCounts,
		sceneHref,
		onMove
	}: {
		// In story order (global position).
		scenes: {
			id: string;
			title: string | null;
			status: SceneStatus;
			wordCount: number;
			chapterId: string | null;
		}[];
		chapters: { id: string; title: string | null }[];
		// Open TODO markers per scene id.
		todoCounts: Record<string, number>;
		sceneHref: (sceneId: string) => ResolvedPathname;
		// Resolves to an error message when the move did not save, else null.
		onMove: (sceneId: string, status: SceneStatus) => Promise<string | null>;
	} = $props();

	const chapterTitles = $derived(
		new Map(chapters.map((chapter, index) => [chapter.id, chapter.title ?? `Chapter ${index + 1}`]))
	);

	let draggingId = $state<string | null>(null);
	let dropLane = $state<SceneStatus | null>(null);
	let moveError = $state<string | null>(null);

	async function move(sceneId: string, status: SceneStatus) {
		moveError = await onMove(sceneId, status);
	}

	function overLane(event: DragEvent, lane: SceneStatus) {
		if (!draggingId) return;
		event.preventDefault();
		dropLane = lane;
	}

	async function dropOnLane(event: DragEvent, lane: SceneStatus) {
		event.preventDefault();
		const sceneId = draggingId;
		draggingId = null;
		dropLane = null;
		if (!sceneId) return;
		const scene = scenes.find((candidate) => candidate.id === sceneId);
		if (!scene || scene.status === lane) return;
		await move(sceneId, lane);
	}

	function endDrag() {
		draggingId = null;
		dropLane = null;
	}

	function step(status: SceneStatus, direction: -1 | 1): SceneStatus | null {
		const index = SCENE_STATUSES.indexOf(status) + direction;
		return index >= 0 && index < SCENE_STATUSES.length ? SCENE_STATUSES[index] : null;
	}
</script>

{#if moveError}
	<div class="board-error"><FormStatus block error={moveError} /></div>
{/if}
<div class="board">
	{#each SCENE_STATUSES as lane (lane)}
		{@const cards = scenes.filter((scene) => scene.status === lane)}
		<section
			class="lane"
			class:drop={dropLane === lane}
			aria-label="{SCENE_STATUS_LABELS[lane]} scenes"
			ondragover={(event) => overLane(event, lane)}
			ondrop={(event) => dropOnLane(event, lane)}
		>
			<header class="lane-head">
				<span class="lane-dot" style="background: var(--status-{lane});"></span>
				<span class="lane-name">{SCENE_STATUS_LABELS[lane]}</span>
				<span class="lane-count">{cards.length}</span>
			</header>
			<div class="lane-cards">
				{#each cards as scene (scene.id)}
					{@const todos = todoCounts[scene.id] ?? 0}
					{@const back = step(scene.status, -1)}
					{@const forward = step(scene.status, 1)}
					<article
						class="card"
						class:dragging={draggingId === scene.id}
						draggable="true"
						ondragstart={(event) => {
							draggingId = scene.id;
							event.dataTransfer?.setData('text/plain', scene.id);
						}}
						ondragend={endDrag}
					>
						<a class="card-title" href={sceneHref(scene.id)}>
							{scene.title ?? 'Untitled scene'}
						</a>
						{#if scene.chapterId}
							<span class="card-chapter">{chapterTitles.get(scene.chapterId)}</span>
						{/if}
						<footer class="card-foot">
							<span class="card-words">{formatNumber(scene.wordCount)} words</span>
							{#if todos > 0}
								<span class="card-todos" title="{todos} open TODO{pluralSuffix(todos)}">
									{todos} TODO{pluralSuffix(todos)}
								</span>
							{/if}
							<span class="card-tools">
								{#if back}
									<button
										type="button"
										class="flip"
										aria-label="Move to {SCENE_STATUS_LABELS[back]}"
										title="Move to {SCENE_STATUS_LABELS[back]}"
										onclick={() => move(scene.id, back)}
									>
										<Icon name="chevron" size={11} />
									</button>
								{/if}
								{#if forward}
									<button
										type="button"
										aria-label="Move to {SCENE_STATUS_LABELS[forward]}"
										title="Move to {SCENE_STATUS_LABELS[forward]}"
										onclick={() => move(scene.id, forward)}
									>
										<Icon name="chevron" size={11} />
									</button>
								{/if}
							</span>
						</footer>
					</article>
				{/each}
				{#if cards.length === 0}
					<div class="empty-state tight">
						<p class="empty-state-text">Nothing here.</p>
					</div>
				{/if}
			</div>
		</section>
	{/each}
</div>

<style>
	.board-error {
		padding: 12px 18px 0;
	}
	/* The board, lanes and cards are global (board.css), shared with the
	   story board. */
	.lane.drop {
		border-color: var(--accent);
	}
	.card {
		cursor: grab;
	}
	.card.dragging {
		opacity: 0.5;
	}
	.card-chapter {
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.card-todos {
		color: var(--cat-amber);
		font-weight: 600;
	}
	.card-tools {
		margin-left: auto;
		display: inline-flex;
		gap: 2px;
		opacity: 0;
	}
	.card:hover .card-tools,
	.card:focus-within .card-tools {
		opacity: 1;
	}
	/* 24px square so a finger can hit it; the icon stays small. */
	.card-tools button {
		display: inline-grid;
		place-items: center;
		min-width: 24px;
		min-height: 24px;
		border: 0;
		background: none;
		color: var(--text-muted);
		padding: 0;
		cursor: pointer;
		border-radius: 4px;
	}
	.card-tools button:hover {
		background: var(--accent-soft);
		color: var(--text);
	}
	.card-tools button.flip {
		transform: scaleX(-1);
	}
</style>
