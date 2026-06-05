<script lang="ts">
	import Icon from './Icon.svelte';
	import { SCENE_STATUSES, SCENE_STATUS_LABELS, type SceneStatus } from '$lib/scene-status';

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
		sceneHref: (sceneId: string) => string;
		onMove: (sceneId: string, status: SceneStatus) => Promise<void>;
	} = $props();

	const chapterTitles = $derived(
		new Map(chapters.map((chapter, index) => [chapter.id, chapter.title ?? `Chapter ${index + 1}`]))
	);

	let draggingId = $state<string | null>(null);
	let dropLane = $state<SceneStatus | null>(null);

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
		await onMove(sceneId, lane);
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
						<!-- eslint-disable svelte/no-navigation-without-resolve (caller resolves the path) -->
						<a class="card-title" href={sceneHref(scene.id)}>
							{scene.title ?? 'Untitled scene'}
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{#if scene.chapterId}
							<span class="card-chapter">{chapterTitles.get(scene.chapterId)}</span>
						{/if}
						<footer class="card-foot">
							<span class="card-words">{scene.wordCount.toLocaleString('en')} words</span>
							{#if todos > 0}
								<span class="card-todos" title="{todos} open TODO{todos === 1 ? '' : 's'}">
									{todos} TODO{todos === 1 ? '' : 's'}
								</span>
							{/if}
							<span class="card-tools">
								{#if back}
									<button
										type="button"
										class="flip"
										aria-label="Move to {SCENE_STATUS_LABELS[back]}"
										title="Move to {SCENE_STATUS_LABELS[back]}"
										onclick={() => onMove(scene.id, back)}
									>
										<Icon name="chevron" size={11} />
									</button>
								{/if}
								{#if forward}
									<button
										type="button"
										aria-label="Move to {SCENE_STATUS_LABELS[forward]}"
										title="Move to {SCENE_STATUS_LABELS[forward]}"
										onclick={() => onMove(scene.id, forward)}
									>
										<Icon name="chevron" size={11} />
									</button>
								{/if}
							</span>
						</footer>
					</article>
				{/each}
				{#if cards.length === 0}
					<p class="lane-empty">Nothing here.</p>
				{/if}
			</div>
		</section>
	{/each}
</div>

<style>
	.board {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		height: 100%;
		overflow-x: auto;
		padding: 18px;
	}
	.lane {
		flex: 1 1 0;
		min-width: 180px;
		max-width: 320px;
		display: flex;
		flex-direction: column;
		max-height: 100%;
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		background: var(--bg-sunken, var(--bg));
	}
	.lane.drop {
		border-color: var(--accent);
	}
	.lane-head {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 10px 12px 8px;
		font-family: var(--font-ui);
	}
	.lane-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
	}
	.lane-name {
		font-size: 12.5px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.lane-count {
		margin-left: auto;
		font-size: 12px;
		color: var(--text-faint);
	}
	.lane-cards {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 0 10px 12px;
		overflow-y: auto;
	}
	.lane-empty {
		color: var(--text-faint);
		font-size: 12.5px;
		margin: 2px 2px 0;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		background: var(--bg-elevated);
		cursor: grab;
	}
	.card.dragging {
		opacity: 0.5;
	}
	.card-title {
		font-family: var(--font-ui);
		font-weight: 600;
		font-size: 13.5px;
		color: var(--text);
		text-decoration: none;
	}
	.card-title:hover {
		text-decoration: underline;
	}
	.card-chapter {
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.card-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
		font-size: 11.5px;
		color: var(--text-muted);
	}
	.card-todos {
		color: var(--cat-amber, #b8860b);
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
	.card-tools button {
		border: 0;
		background: none;
		color: var(--text-muted);
		padding: 1px 3px;
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
