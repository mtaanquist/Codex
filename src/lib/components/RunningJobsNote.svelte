<script lang="ts">
	import { resolve } from '$app/paths';
	import { trackedJobs, type TrackedJob } from '#lib/activity.svelte';

	// One line per Assistant job still running on this story, under the mode
	// strip, so a review started earlier (or before a reload) stays visible on
	// every story page. The list is the activity center's: the jobs this tab
	// started or picked up on load, with the progress its polling reads.
	let { storyId }: { storyId: string } = $props();

	const jobs = $derived(trackedJobs.list.filter((job) => job.storyId === storyId));

	function describe(job: TrackedJob): string {
		if (job.kind === 'summaries') return 'The Assistant is updating summaries';
		if (job.mode === 'continuity') return 'The Assistant is checking continuity';
		const p = job.progress;
		if (p?.phase === 'scenes' && p.total > 0) {
			return `Assistant review: ${p.completed} of ${p.total} scenes`;
		}
		if (p?.phase === 'summaries') return 'Assistant review: updating summaries first';
		if (p?.phase === 'consistency') return 'Assistant review: checking consistency';
		return 'Assistant review starting';
	}
</script>

{#each jobs as job (job.id)}
	<p class="mode-note run-note" role="status">
		<span class="run-dot" aria-hidden="true"></span>
		{#if job.kind === 'review'}
			<a href={resolve('/stories/[id]/review', { id: storyId })}>{describe(job)}</a>
		{:else}
			{describe(job)}
		{/if}
	</p>
{/each}

<style>
	.run-note {
		display: flex;
		align-items: baseline;
		gap: 7px;
		color: var(--text-muted);
	}
	.run-note a {
		color: inherit;
	}
	.run-note a:hover {
		color: var(--text);
	}
	.run-dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		animation: run-pulse 1.6s ease-in-out infinite;
	}
	@keyframes run-pulse {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.run-dot {
			animation: none;
		}
	}
</style>
