<script lang="ts">
	import type { StoryStatus } from '$lib/dashboard';

	// The universe's stories as cards in status lanes, mirroring the scene
	// board's look. The status is derived from each story's scenes (the
	// same derivation as the library pill), so the board is a read-only
	// overview; cards open the story.
	let {
		stories
	}: {
		stories: {
			id: string;
			href: string;
			title: string;
			status: StoryStatus;
			words: number;
			sceneCount: number;
		}[];
	} = $props();

	const LANES: StoryStatus[] = [
		{ label: 'Outlining', token: 'outline' },
		{ label: 'Drafting', token: 'draft' },
		{ label: 'Revising', token: 'revised' },
		{ label: 'Final', token: 'final' }
	];
</script>

<div class="board">
	{#each LANES as lane (lane.token)}
		{@const cards = stories.filter((story) => story.status.token === lane.token)}
		<section class="lane" aria-label="{lane.label} stories">
			<header class="lane-head">
				<span class="lane-dot" style="background: var(--status-{lane.token});"></span>
				<span class="lane-name">{lane.label}</span>
				<span class="lane-count">{cards.length}</span>
			</header>
			<div class="lane-cards">
				{#each cards as story (story.id)}
					<article class="card">
						<!-- eslint-disable svelte/no-navigation-without-resolve (caller resolves the path) -->
						<a class="card-title" href={story.href}>{story.title}</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						<footer class="card-foot">
							<span>{story.words.toLocaleString('en')} words</span>
							<span>{story.sceneCount} scene{story.sceneCount === 1 ? '' : 's'}</span>
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
	.card-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
		font-size: 11.5px;
		color: var(--text-muted);
	}
</style>
