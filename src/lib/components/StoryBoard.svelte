<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import type { StoryStatus } from '$lib/dashboard';
	import { formatNumber, pluralSuffix } from '$lib/format';

	// The universe's stories as cards in status lanes, mirroring the scene
	// board's look. The status is derived from each story's scenes (the
	// same derivation as the library pill), so the board is a read-only
	// overview; cards open the story.
	let {
		stories
	}: {
		stories: {
			id: string;
			href: ResolvedPathname;
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
						<a class="card-title" href={story.href}>{story.title}</a>
						<footer class="card-foot">
							<span>{formatNumber(story.words)} words</span>
							<span>{story.sceneCount} scene{pluralSuffix(story.sceneCount)}</span>
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
