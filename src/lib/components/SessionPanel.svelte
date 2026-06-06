<script lang="ts">
	// The right pane's Session tab: today's words, the week's writing days,
	// and the streak, with the full Insights view a click away. Data loads
	// when the panel first shows, not with the page.
	import Icon from './Icon.svelte';

	let {
		universeSlug,
		storyId = null
	}: {
		universeSlug: string;
		// Set on story screens; today's count narrows to the open story.
		storyId?: string | null;
	} = $props();

	type SessionData = {
		words: number;
		storyWords: number | null;
		week: { label: string; active: boolean; isToday: boolean }[];
		streak: { current: number; longest: number };
	};
	let session = $state<SessionData | null>(null);
	let failed = $state(false);

	$effect(() => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
		const query = storyId
			? `tz=${encodeURIComponent(timezone)}&story=${encodeURIComponent(storyId)}`
			: `tz=${encodeURIComponent(timezone)}`;
		let stale = false;
		fetch(`/api/universes/${universeSlug}/session?${query}`)
			.then((response) => (response.ok ? response.json() : Promise.reject()))
			.then((data) => {
				if (!stale) session = data as SessionData;
			})
			.catch(() => {
				if (!stale) failed = true;
			});
		return () => {
			stale = true;
		};
	});

	const todayWords = $derived(session ? (session.storyWords ?? session.words) : 0);
</script>

<div class="right-scroll">
	{#if failed}
		<div class="r-card"><h5>Session</h5></div>
	{:else if !session}
		<div class="r-card"><h5>Session</h5></div>
	{:else}
		<div class="r-card">
			<h5>Today</h5>
			<div class="sess-grid">
				<div class="sess-stat">
					<div class="sess-n">{todayWords.toLocaleString('en-US')}</div>
					<div class="sess-l">
						{storyId ? 'words in this story' : 'words in this universe'}
					</div>
				</div>
				{#if storyId !== null}
					<div class="sess-stat">
						<div class="sess-n">{session.words.toLocaleString('en-US')}</div>
						<div class="sess-l">across the universe</div>
					</div>
				{/if}
			</div>
		</div>
		<div class="r-card">
			<h5>Streak</h5>
			<div class="streak-row">
				{#each session.week as day, index (index)}
					<div class="streak-day" class:on={day.active} class:today={day.isToday}>
						{day.label}
					</div>
				{/each}
			</div>
			<div class="goal-meta">
				<span>
					{session.streak.current === 0 ? 'No streak yet' : `${session.streak.current}-day streak`}
				</span>
				<span>longest {session.streak.longest}</span>
			</div>
		</div>
		<div class="r-card">
			<!-- eslint-disable svelte/no-navigation-without-resolve (app path from a slug) -->
			<a class="session-insights" href={`/universes/${universeSlug}/insights`}>
				All insights <Icon name="arrow-out" size={12} />
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
			<span class="session-insights-hint">Opens the full insights page.</span>
		</div>
	{/if}
</div>

<style>
	.session-insights {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
	}
	.session-insights:hover {
		text-decoration: underline;
	}
	.session-insights-hint {
		display: block;
		margin-top: 4px;
		font-size: 11.5px;
		color: var(--text-faint);
	}
</style>
