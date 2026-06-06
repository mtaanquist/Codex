<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { entityColor } from '$lib/entity-color';
	import PaletteButton from '$lib/components/PaletteButton.svelte';
	import RelationshipWeb from '$lib/components/RelationshipWeb.svelte';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import NotificationBell from '$lib/components/NotificationBell.svelte';
	import HelpLink from '$lib/components/HelpLink.svelte';
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

	const NAV = [
		{ id: 'progress', label: 'Progress' },
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
	const universeColor = $derived(entityColor(data.universe.name));

	const totalWords = $derived(data.stories.reduce((sum, story) => sum + story.words, 0));
	const totalScenes = $derived(data.stories.reduce((sum, story) => sum + story.sceneCount, 0));
	const finalScenes = $derived(data.stories.reduce((sum, story) => sum + story.status.final, 0));
	const weekWords = $derived(data.activity.daily.slice(-7).reduce((sum, d) => sum + d.words, 0));
	const monthWords = $derived(data.activity.daily.reduce((sum, d) => sum + d.words, 0));

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

	function formatNumber(n: number): string {
		return n.toLocaleString('en');
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

<div class="page-shell">
	<header class="topbar">
		<a class="brand" href={resolve('/')}>
			<span class="brand-name">Codex</span>
		</a>
		<span class="divider"></span>
		<a class="back-link" href={planPath}>
			<svg
				viewBox="0 0 12 12"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"><polyline points="7.5 2.5 3 6 7.5 9.5" /></svg
			>
			{data.universe.name}
		</a>
		<span class="spacer"></span>
		<PaletteButton />
		<HelpLink topic="planning" label="the planning view" />
		<NotificationBell />
		<UserMenu />
	</header>

	<div class="admin-shell">
		<aside class="admin-sidebar">
			<div class="admin-sidebar-title">
				<span class="ic badge sm" style="background: {universeColor}; color: #fff;">
					{data.universe.name.slice(0, 1).toUpperCase()}
				</span>
				<div>
					<div class="tt">{data.universe.name}</div>
					<div class="st">Universe</div>
				</div>
			</div>
			<nav class="admin-nav">
				<div class="admin-nav-label">Insights</div>
				{#each NAV as item (item.id)}
					<a class="nav-item" href="#{item.id}">{item.label}</a>
				{/each}
			</nav>
		</aside>

		<main class="admin-main page-body">
			<div class="admin-main-inner">
				<div class="admin-head">
					<p class="admin-eyebrow">{data.universe.name}</p>
					<h1 class="admin-title">Insights</h1>
					<p class="admin-lede">How the writing and the world are coming along.</p>
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

				<div class="admin-block" id="stories">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Stories</h2>
						<p class="admin-block-sub">Where each story stands, scene by scene.</p>
					</div>
					{#if data.stories.length === 0}
						<p class="insights-empty">No stories in this universe yet.</p>
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
										<p class="insights-empty">No scenes yet.</p>
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
						<p class="insights-empty">
							No characters, places, or lore yet. Add them in the Plan view.
						</p>
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
	</div>
</div>

<style>
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

	.insights-empty {
		color: var(--text-muted);
		font-size: 13px;
		margin: 0;
	}
</style>
