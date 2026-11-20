<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { openHref } from '#lib/open-href';
	import { dismiss } from '#lib/dismiss';
	import { now } from '#lib/now.svelte';
	import { trackedJobs, type TrackedJob } from '#lib/activity.svelte';
	import { resumeRunningJobs } from '#lib/assistant-actions';

	// The topbar's list of the Assistant's background work: every job this
	// writer has queued or running, with how long it has been going, a way to
	// stop it and a link to where its result will show. The button is there
	// only while something is running. The list is the activity center's own
	// (see #lib/activity.svelte), so a card dismissed from the corner still
	// has its job here; finished work is the notification bell's.

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	const jobs = $derived(trackedJobs.list);

	function toggle() {
		open = !open;
		// A job started in another tab shows up without waiting for a reload.
		if (open) void resumeRunningJobs();
	}

	// Nothing left to list closes the panel with its button.
	$effect(() => {
		if (jobs.length === 0) open = false;
	});

	function elapsed(job: TrackedJob): string {
		const minutes = Math.floor((now() - job.startedAt) / 60_000);
		if (minutes < 1) return 'Started just now';
		if (minutes < 60) return `Started ${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		return `Started ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
	}

	function progress(job: TrackedJob): string {
		const p = job.progress;
		if (job.stopping) return 'Stopping...';
		if (job.stopError) return job.stopError;
		if (p?.phase === 'scenes' && p.total > 0) return `${p.completed} of ${p.total} scenes`;
		if (p?.phase === 'summaries') return 'Updating summaries first';
		if (p?.phase === 'patterns') return 'Looking for repeated habits';
		if (p?.phase === 'consistency') return 'Checking consistency';
		return '';
	}

	// Where the job's result shows: its own page when it has one, else the
	// story or the universe it is about.
	function place(job: TrackedJob): ResolvedPathname | null {
		if (job.href) return job.href as ResolvedPathname;
		if (job.storyId && (job.kind === 'enrich' || job.kind === 'details')) {
			return resolve('/stories/[id]/plan', { id: job.storyId });
		}
		if (job.storyId) return resolve('/stories/[id]', { id: job.storyId });
		if (job.universeId) return resolve('/universes/[id]/plan', { id: job.universeId });
		return null;
	}

	async function go(href: ResolvedPathname) {
		open = false;
		await openHref(href);
	}
</script>

{#if jobs.length > 0}
	<div
		class="work"
		use:dismiss={{ enabled: open, close: () => (open = false), refocus: () => trigger?.focus() }}
	>
		<button
			bind:this={trigger}
			class="icon-btn work-btn"
			type="button"
			title="Background work"
			aria-label={`Background work, ${jobs.length} running`}
			aria-haspopup="dialog"
			aria-expanded={open}
			onclick={toggle}
		>
			<span class="work-spinner" aria-hidden="true"></span>
			<span class="work-count" aria-hidden="true">{jobs.length > 9 ? '9+' : jobs.length}</span>
		</button>

		{#if open}
			<div class="work-panel" role="dialog" aria-label="Background work">
				<div class="work-head">Background work</div>
				<ul class="work-list">
					{#each jobs as job (job.id)}
						{@const href = place(job)}
						{@const detail = progress(job)}
						<li class="work-item">
							<span class="work-label">{job.label}</span>
							<span class="work-meta">
								{elapsed(job)}{#if detail}, {detail}{/if}
							</span>
							<span class="work-actions">
								{#if href}
									<button class="work-link" type="button" onclick={() => go(href)}>Open</button>
								{/if}
								{#if job.stop || job.stopping}
									<!-- Kept while a stop is on its way, so the keyboard focus stays put. -->
									<button
										class="work-link"
										type="button"
										aria-disabled={job.stopping}
										onclick={() => job.stop?.()}
									>
										Stop
									</button>
								{/if}
							</span>
						</li>
					{/each}
				</ul>
				<p class="work-foot">You get a notification when each one is done.</p>
			</div>
		{/if}
	</div>
{/if}

<style>
	.work {
		position: relative;
	}
	.work-btn {
		position: relative;
	}
	.work-spinner {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid color-mix(in oklab, var(--accent) 30%, transparent);
		border-top-color: var(--accent);
		animation: work-spin 0.9s linear infinite;
	}
	@keyframes work-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.work-spinner {
			animation: none;
		}
	}
	.work-count {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: 8px;
		background: var(--accent-fill);
		color: var(--accent-contrast);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
		text-align: center;
	}
	.work-panel {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		width: 320px;
		max-width: calc(100vw - 24px);
		max-height: 420px;
		overflow-y: auto;
		background: var(--bg-elevated);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow);
		z-index: 60;
	}
	.work-head {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
		font-size: 12px;
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.work-list {
		list-style: none;
		margin: 0;
		padding: 4px;
		display: grid;
		gap: 2px;
	}
	.work-item {
		display: grid;
		gap: 3px;
		padding: 8px;
	}
	.work-label {
		font-size: 13px;
		line-height: 1.35;
		color: var(--text);
	}
	.work-meta {
		font-size: 12px;
		color: var(--text-muted);
	}
	.work-actions {
		display: flex;
		gap: 12px;
	}
	.work-link {
		border: 0;
		background: none;
		color: var(--accent-ink);
		font-size: 12px;
		cursor: pointer;
		padding: 0;
	}
	.work-link:hover {
		text-decoration: underline;
	}
	.work-link[aria-disabled='true'] {
		color: var(--text-faint);
		cursor: default;
		text-decoration: none;
	}
	.work-foot {
		margin: 0;
		padding: 8px 12px 10px;
		border-top: 1px solid var(--border);
		font-size: 12px;
		color: var(--text-faint);
	}
</style>
