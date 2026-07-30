<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { entityColor } from '$lib/entity-color';
	import { daysMetGoal, daysUntil } from '$lib/insights';
	import { formatNumber } from '$lib/format';
	import AppBar from '$lib/components/AppBar.svelte';
	import { INSIGHTS_MODE_NOTE, universePath } from '$lib/chrome';
	import ModeSwitcher from '$lib/components/ModeSwitcher.svelte';
	import PanelStrip from '$lib/components/PanelStrip.svelte';
	import AssistantPanel from '$lib/components/AssistantPanel.svelte';
	import RelationshipWeb from '$lib/components/RelationshipWeb.svelte';
	import { visiblePanels } from '$lib/panels';
	import { page } from '$app/state';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Day boundaries follow the author's clock. The server reads the timezone
	// cookie; on the first visit (or a changed clock) set it and reload the
	// data once.
	onMount(() => {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (timezone && timezone !== data.timezone) {
			document.cookie = `codex-tz=${encodeURIComponent(timezone)}; path=/; max-age=31536000; samesite=lax`;
			invalidateAll();
		}
	});

	// The left pane below the mode strip is always the contents of the centre;
	// here that is this page's own sections. Its own class, not .side-nav, which
	// means routes to the sibling pages of a settings family.
	const NAV = [
		{ id: 'progress', label: 'Progress' },
		{ id: 'sessions', label: 'Writing sessions' },
		{ id: 'stories', label: 'Stories' },
		{ id: 'heatmap', label: 'World heatmap' },
		{ id: 'web', label: 'Relationship web' }
	];

	const STATUS_ORDER = ['outline', 'draft', 'revised', 'final'] as const;
	const STATUS_LABELS: Record<string, string> = {
		outline: 'Outline',
		draft: 'Draft',
		revised: 'Revised',
		final: 'Final'
	};
	const TYPE_LABELS: Record<string, string> = {
		character: 'Characters',
		place: 'Places',
		lore_entry: 'Lore'
	};

	const planPath = $derived(resolve('/universes/[id]/plan', { id: data.universe.slug }));

	// Insights has no document, only numbers, so the Assistant is the one panel
	// with a subject; when the account has it off, the pane closes.
	const panels = $derived(visiblePanels({ assistant: data.assistant.tabEnabled }));

	// Grounded starter prompts, leaning on the Assistant's reach across the
	// whole universe.
	const assistantSuggestions = $derived.by(() => {
		const named = data.heat.filter((entity) => entity.type === 'character').map((e) => e.name);
		const prompts: string[] = [];
		if (named[0]) prompts.push(`What happens to ${named[0]} across the stories?`);
		prompts.push('What should I write next in this universe?');
		prompts.push('Which parts of this world is the prose not using?');
		return prompts;
	});

	const totalWords = $derived(data.stories.reduce((sum, story) => sum + story.words, 0));
	const totalScenes = $derived(data.stories.reduce((sum, story) => sum + story.sceneCount, 0));
	const finalScenes = $derived(data.stories.reduce((sum, story) => sum + story.status.final, 0));
	const weekWords = $derived(data.activity.daily.slice(-7).reduce((sum, d) => sum + d.words, 0));
	const monthWords = $derived(data.activity.daily.reduce((sum, d) => sum + d.words, 0));
	const todayWords = $derived(data.activity.daily.at(-1)?.words ?? 0);
	const goalMetDays = $derived(daysMetGoal(data.activity.daily, data.dailyGoal));

	// The last seven days as a strip: which days were written on, and which one
	// is today. The stats the story pane used to carry live here now.
	const week = $derived(
		data.activity.daily.slice(-7).map((entry) => ({
			day: entry.day,
			label: new Date(`${entry.day}T00:00:00Z`).toLocaleDateString('en-US', {
				weekday: 'narrow',
				timeZone: 'UTC'
			}),
			written: entry.words !== 0,
			isToday: entry.day === data.activity.today
		}))
	);
	const weekDaysWritten = $derived(week.filter((day) => day.written).length);
	const monthDaysWritten = $derived(
		data.activity.daily.filter((entry) => entry.words !== 0).length
	);
	const goalPercent = $derived(
		data.dailyGoal > 0 ? Math.min(100, Math.round((todayWords / data.dailyGoal) * 100)) : 0
	);

	// Chart geometry: positive bars rise from the baseline, trimming days dip
	// below it, both scaled to the loudest day in the window.
	const CHART_W = 600;
	const CHART_H = 140;
	const BASELINE = 104;
	const maxAbs = $derived(Math.max(1, ...data.activity.daily.map((d) => Math.abs(d.words))));
	const barW = $derived(CHART_W / data.activity.daily.length);
	function barHeight(words: number): number {
		const room = words >= 0 ? BASELINE - 8 : CHART_H - BASELINE - 8;
		return Math.max(words === 0 ? 0 : 2, Math.round((Math.abs(words) / maxAbs) * room));
	}

	function formatDay(day: string): string {
		const [, month, date] = day.split('-');
		return `${Number(date)}/${Number(month)}`;
	}

	const heatMax = $derived(Math.max(1, ...data.heat.map((entity) => entity.mentionCount)));
	function heatStrength(mentions: number): number {
		if (mentions === 0) return 0;
		return Math.round(10 + 35 * (mentions / heatMax));
	}

	function heatTitle(entity: PageData['heat'][number]): string {
		const parts = [
			entity.mentionCount === 0
				? 'Not mentioned in any scene yet'
				: `Mentioned ${entity.mentionCount} ${entity.mentionCount === 1 ? 'time' : 'times'} across ${entity.sceneCount} ${entity.sceneCount === 1 ? 'scene' : 'scenes'}`
		];
		if (!entity.hasBody) parts.push('no entry written yet');
		return parts.join('; ');
	}
</script>

<svelte:head>
	<title>{data.universe.name} - Insights - Codex</title>
</svelte:head>

<div class="app">
	<AppBar
		crumbs={universePath(data.universe, { universeAt: 'insights', page: 'Insights' })}
		helpTopic="planning"
		helpLabel="insights"
	/>
	<div class="body" class:no-right={panels.length === 0}>
		<aside class="pane left">
			<div class="left-head">
				<!-- Insights is not one of the three modes, so none of them is lit and
				     one line says why. -->
				<ModeSwitcher
					active={null}
					hrefs={{ write: planPath, plan: planPath, review: planPath }}
					note={INSIGHTS_MODE_NOTE}
				/>
			</div>
			<div class="left-scroll">
				<div class="group-label">On this page<span class="count">{NAV.length}</span></div>
				<nav class="contents-nav" aria-label="Sections of this page">
					{#each NAV as item (item.id)}
						<a
							href="#{item.id}"
							aria-current={page.url.hash === `#${item.id}` ? 'true' : undefined}
						>
							{item.label}
						</a>
					{/each}
				</nav>
			</div>
		</aside>
		<main class="pane center">
			<div class="insights-body">
				<div class="page-header">
					<div>
						<h1 class="page-title">Insights</h1>
						<p class="page-subtitle">
							What you have written across this universe, and how much of the world the prose uses.
							Nothing here is editable; use it to decide what to write next.
						</p>
					</div>
				</div>

				<div class="admin-block" id="progress">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Progress</h2>
						<p class="admin-block-sub">Word counts and writing rhythm across this universe.</p>
					</div>
					<div class="admin-stat-grid">
						<div class="admin-stat">
							<div class="admin-stat-top"><span class="admin-stat-label">Total words</span></div>
							<div class="admin-stat-n">{formatNumber(totalWords)}</div>
							<div class="admin-stat-foot">
								across {data.stories.length}
								{data.stories.length === 1 ? 'story' : 'stories'}
							</div>
						</div>
						<div class="admin-stat">
							<div class="admin-stat-top"><span class="admin-stat-label">This week</span></div>
							<div class="admin-stat-n">{formatNumber(weekWords)}</div>
							<div class="admin-stat-foot">
								net words; <span class="delta flat">{formatNumber(monthWords)}</span> in 30 days
							</div>
						</div>
						<div class="admin-stat">
							<div class="admin-stat-top"><span class="admin-stat-label">Streak</span></div>
							<div class="admin-stat-n">
								{data.activity.streak.current}
								{data.activity.streak.current === 1 ? 'day' : 'days'}
							</div>
							<div class="admin-stat-foot">
								longest this year: {data.activity.streak.longest}
							</div>
						</div>
						<div class="admin-stat">
							<div class="admin-stat-top"><span class="admin-stat-label">Scenes</span></div>
							<div class="admin-stat-n">{formatNumber(totalScenes)}</div>
							<div class="admin-stat-foot">
								<span class="delta flat">{finalScenes}</span> final
							</div>
						</div>
						{#if data.dailyGoal > 0}
							<div class="admin-stat">
								<div class="admin-stat-top"><span class="admin-stat-label">Daily goal</span></div>
								<div class="admin-stat-n">
									{formatNumber(todayWords)} / {formatNumber(data.dailyGoal)}
								</div>
								<div class="admin-stat-foot">
									{todayWords >= data.dailyGoal ? 'met today; ' : ''}{goalMetDays} of the last 30 days
								</div>
							</div>
						{/if}
					</div>

					<div class="chart-card">
						<h3 class="chart-title">Words per day, last 30 days</h3>
						<svg
							class="chart"
							viewBox="0 0 {CHART_W} {CHART_H}"
							role="img"
							aria-label="Net words written per day over the last 30 days"
						>
							<line class="chart-axis" x1="0" y1={BASELINE} x2={CHART_W} y2={BASELINE} />
							{#each data.activity.daily as point, i (point.day)}
								{#if point.words !== 0}
									<rect
										class="chart-bar"
										class:negative={point.words < 0}
										x={i * barW + 1.5}
										y={point.words >= 0 ? BASELINE - barHeight(point.words) : BASELINE}
										width={Math.max(1, barW - 3)}
										height={barHeight(point.words)}
									>
										<title>{formatDay(point.day)}: {formatNumber(point.words)} words</title>
									</rect>
								{/if}
							{/each}
						</svg>
						<div class="chart-range">
							<span>{formatDay(data.activity.daily[0].day)}</span>
							<span>{formatDay(data.activity.daily[data.activity.daily.length - 1].day)}</span>
						</div>
					</div>
				</div>

				<div class="admin-block" id="sessions">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Writing sessions</h2>
						<p class="admin-block-sub">
							What you have written today, and the days you have written on lately.
						</p>
					</div>
					<div class="admin-stat-grid">
						<div class="admin-stat">
							<div class="admin-stat-top"><span class="admin-stat-label">Today</span></div>
							<div class="admin-stat-n">{formatNumber(todayWords)}</div>
							<div class="admin-stat-foot">net words in this universe</div>
						</div>
						<div class="admin-stat">
							<div class="admin-stat-top"><span class="admin-stat-label">Days written</span></div>
							<div class="admin-stat-n">{monthDaysWritten}</div>
							<div class="admin-stat-foot">of the last 30; {weekDaysWritten} of the last 7</div>
						</div>
					</div>
					{#if data.showStreak}
						<div class="week-card">
							<h3 class="chart-title">The last seven days</h3>
							<div class="week-row">
								{#each week as day (day.day)}
									<div
										class="week-day"
										class:on={day.written}
										class:today={day.isToday}
										title="{day.day}: {day.written ? 'written' : 'nothing written'}"
									>
										{day.label}
									</div>
								{/each}
							</div>
						</div>
					{/if}
					{#if data.dailyGoal > 0}
						<div class="goal-line">
							<div class="goal-track">
								<div class="goal-fill" style="width: {goalPercent}%"></div>
							</div>
							<span class="goal-text">
								{todayWords >= data.dailyGoal
									? 'Daily goal met'
									: `${formatNumber(todayWords)} / ${formatNumber(data.dailyGoal)} today`}
							</span>
						</div>
					{/if}
				</div>

				<div class="admin-block" id="stories">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Stories</h2>
						<p class="admin-block-sub">Where each story stands, scene by scene.</p>
					</div>
					{#if data.stories.length === 0}
						<div class="empty-state tight">
							<p class="empty-state-text">No stories in this universe yet.</p>
						</div>
					{:else}
						<div class="story-rows">
							{#each data.stories as story (story.id)}
								<div class="story-row">
									<div class="story-row-head">
										<a class="story-row-title" href={resolve('/stories/[id]', { id: story.slug })}>
											{story.title}
										</a>
										<span class="story-row-meta">
											{formatNumber(story.words)} words · {story.sceneCount}
											{story.sceneCount === 1 ? 'scene' : 'scenes'}
										</span>
									</div>
									{#if story.targetWords || story.deadline}
										{@const left = daysUntil(story.deadline, data.activity.today)}
										<div class="goal-line">
											{#if story.targetWords}
												{@const pct = Math.min(
													100,
													Math.round((story.words / story.targetWords) * 100)
												)}
												<div class="goal-track">
													<div class="goal-fill" style="width: {pct}%"></div>
												</div>
												<span class="goal-text">
													{pct}% of {formatNumber(story.targetWords)} words
												</span>
											{/if}
											{#if left !== null}
												<span class="goal-text deadline">
													{left > 0
														? `due in ${left} ${left === 1 ? 'day' : 'days'}`
														: left === 0
															? 'due today'
															: `${-left} ${left === -1 ? 'day' : 'days'} overdue`}
												</span>
											{/if}
										</div>
									{/if}
									{#if story.sceneCount > 0}
										<div class="status-bar">
											{#each STATUS_ORDER as status (status)}
												{#if story.status[status] > 0}
													<span
														class="status-seg"
														style="flex-grow: {story.status[
															status
														]}; background: var(--status-{status});"
														title="{story.status[status]} {STATUS_LABELS[status].toLowerCase()}"
													></span>
												{/if}
											{/each}
										</div>
										<div class="status-legend">
											{#each STATUS_ORDER as status (status)}
												{#if story.status[status] > 0}
													<span class="status-key">
														<span class="status-dot" style="background: var(--status-{status});"
														></span>
														{story.status[status]}
														{STATUS_LABELS[status].toLowerCase()}
													</span>
												{/if}
											{/each}
										</div>
									{:else}
										<div class="empty-state tight">
											<p class="empty-state-text">No scenes yet.</p>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<div class="admin-block" id="heatmap">
					<div class="admin-block-head">
						<h2 class="admin-block-title">World heatmap</h2>
						<p class="admin-block-sub">
							Which parts of the world the prose actually visits. Brighter means mentioned more;
							pale tiles are going unused.
						</p>
					</div>
					{#if data.heat.length === 0}
						<div class="empty-state tight">
							<p class="empty-state-text">
								No characters, places, or lore yet. Add them in the Plan view.
							</p>
						</div>
					{:else}
						{#each ['character', 'place', 'lore_entry'] as type (type)}
							{@const group = data.heat.filter((entity) => entity.type === type)}
							{#if group.length > 0}
								<div class="heat-group">
									<h3 class="heat-group-title">
										{TYPE_LABELS[type]} <span class="heat-group-count">{group.length}</span>
									</h3>
									<div class="heat-grid">
										{#each group as entity (entity.id)}
											<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
											<a
												class="heat-tile"
												class:cold={entity.mentionCount === 0}
												style="--heat: {heatStrength(entity.mentionCount)}%;"
												href={`${planPath}?entity=${entity.id}`}
												title={heatTitle(entity)}
											>
												<span class="heat-tile-head">
													<span
														class="badge dot"
														style="background: {entity.color ?? entityColor(entity.name)}"
													></span>
													<span class="heat-tile-name">{entity.name}</span>
												</span>
												<span class="heat-tile-meta">
													{#if entity.mentionCount > 0}
														{entity.mentionCount}
														{entity.mentionCount === 1 ? 'mention' : 'mentions'} · {entity.sceneCount}
														{entity.sceneCount === 1 ? 'scene' : 'scenes'}
													{:else}
														Not mentioned yet
													{/if}
													{#if !entity.hasBody}
														· no entry
													{/if}
												</span>
											</a>
											<!-- eslint-enable svelte/no-navigation-without-resolve -->
										{/each}
									</div>
								</div>
							{/if}
						{/each}
					{/if}
				</div>

				<div class="admin-block" id="web">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Relationship web</h2>
						<p class="admin-block-sub">
							Who connects to whom. Hover a node to read its relationships; click it to open the
							entry.
						</p>
					</div>
					<RelationshipWeb
						entities={data.heat}
						links={data.web}
						entityHref={(id) => `${planPath}?entity=${id}`}
					/>
				</div>
			</div>
		</main>
		{#if panels.length > 0}
			<aside class="pane right">
				<PanelStrip {panels} active="assistant" onSelect={() => {}} sub="this universe">
					{#snippet panel()}
						<AssistantPanel
							scope={{ universeId: data.universe.id, universeName: data.universe.name }}
							name={data.assistant.name}
							suggestions={assistantSuggestions}
							initialMessages={data.assistantChat}
						/>
						<p class="panel-note">
							The only panel that has a subject on this page: the numbers in the middle. Reference,
							History and Notes belong to a document you are editing, so they are not here.
						</p>
					{/snippet}
				</PanelStrip>
			</aside>
		{/if}
	</div>
</div>

<style>
	/* The centre of a workspace page holds one measured column. */
	.insights-body {
		max-width: 820px;
		margin: 0 auto;
		padding: 34px var(--space-8) 90px;
	}
	.week-card {
		margin-top: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elevated);
		padding: 14px 16px;
	}
	.week-row {
		display: flex;
		gap: 6px;
	}
	.week-day {
		flex: 1;
		display: grid;
		place-items: center;
		height: 30px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-inset);
		color: var(--text-faint);
		font-size: var(--text-meta);
	}
	.week-day.on {
		background: var(--accent-soft);
		border-color: var(--accent-line);
		color: var(--text);
	}
	.week-day.today {
		font-weight: 700;
		color: var(--text);
	}
	.chart-card {
		margin-top: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		background: var(--bg-elevated);
		padding: 14px 16px 10px;
	}
	.chart-title {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin: 0 0 8px;
	}
	.chart {
		display: block;
		width: 100%;
		height: auto;
	}
	.chart-axis {
		stroke: var(--border);
		stroke-width: 1;
	}
	.chart-bar {
		fill: var(--accent);
	}
	.chart-bar.negative {
		fill: var(--danger, #c0564f);
		opacity: 0.7;
	}
	.chart-range {
		display: flex;
		justify-content: space-between;
		font-size: 11.5px;
		color: var(--text-faint);
		padding-top: 4px;
	}

	.story-rows {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.story-row-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 7px;
	}
	.story-row-title {
		font-weight: 600;
		font-size: 14.5px;
		color: var(--text);
		text-decoration: none;
	}
	.story-row-title:hover {
		text-decoration: underline;
	}
	.story-row-meta {
		font-size: 12.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.goal-line {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 2px 0 2px;
	}
	.goal-track {
		flex: 1;
		min-width: 0;
		height: 6px;
		border-radius: 3px;
		background: var(--bg-inset);
		overflow: hidden;
	}
	.goal-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 3px;
	}
	.goal-text {
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.goal-text.deadline {
		color: var(--text-faint);
	}
	.status-bar {
		display: flex;
		gap: 2px;
		height: 10px;
		border-radius: 5px;
		overflow: hidden;
	}
	.status-seg {
		min-width: 6px;
	}
	.status-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin-top: 7px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.status-key {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.heat-group {
		margin-top: 14px;
	}
	.heat-group-title {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin: 0 0 8px;
	}
	.heat-group-count {
		font-weight: 500;
		margin-left: 4px;
	}
	.heat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
		gap: 8px;
	}
	.heat-tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		background: color-mix(in oklab, var(--accent) var(--heat), var(--bg-elevated));
		text-decoration: none;
		color: var(--text);
	}
	.heat-tile:hover {
		border-color: var(--accent);
	}
	.heat-tile.cold {
		background: var(--bg-elevated);
	}
	.heat-tile.cold .heat-tile-name {
		color: var(--text-muted);
	}
	.heat-tile-head {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.heat-tile-head .badge.dot {
		flex: 0 0 auto;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		padding: 0;
	}
	.heat-tile-name {
		font-weight: 600;
		font-size: 13.5px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.heat-tile-meta {
		font-size: 11.5px;
		color: var(--text-muted);
	}
</style>
