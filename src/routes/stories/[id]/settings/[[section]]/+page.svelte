<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { beforeNavigate } from '$app/navigation';
	import { flushFocusedField } from '$lib/autosave-form';
	import { entityColor } from '$lib/entity-color';
	import PageTopBar from '$lib/components/PageTopBar.svelte';
	import SettingsShell from '$lib/components/SettingsShell.svelte';
	import SettingsDetails from './SettingsDetails.svelte';
	import SettingsEditor from './SettingsEditor.svelte';
	import SettingsPageSetup from './SettingsPageSetup.svelte';
	import SettingsGoals from './SettingsGoals.svelte';
	import SettingsCover from './SettingsCover.svelte';
	import SettingsPublish from './SettingsPublish.svelte';
	import SettingsReview from './SettingsReview.svelte';
	import SettingsExport from './SettingsExport.svelte';
	import SettingsHistory from './SettingsHistory.svelte';
	import SettingsDanger from './SettingsDanger.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Each section is its own page (/settings/pagesetup, /settings/export, ...);
	// a plain /settings is the details. Forms post to the section they sit on.
	const active = $derived(page.params.section ?? 'details');

	// The help article that covers the open section; the rest fall back to
	// the general one.
	const HELP_BY_SECTION: Record<string, string> = {
		publish: 'publishing',
		cover: 'publishing',
		pagesetup: 'publishing',
		review: 'reviewing',
		editor: 'editor',
		goals: 'planning'
	};
	const helpTopic = $derived(HELP_BY_SECTION[active] ?? 'getting-started');

	function sectionHref(section: string): string {
		return resolve('/stories/[id]/settings/[[section]]', {
			id: data.story.slug,
			section: section === 'details' ? undefined : section
		});
	}

	// The settings forms (Editor, Page setup, Goals) save on change instead of
	// with a button; see $lib/autosave-form.
	beforeNavigate(flushFocusedField);

	const coverColor = $derived(entityColor(data.story.title));

	// Cover uploads need asset storage and publishing needs a public shelf;
	// without those the sections hide entirely rather than explaining server
	// configuration to a writer.
	const NAV = $derived(
		[
			{ id: 'details', label: 'Details' },
			{ id: 'editor', label: 'Editor' },
			{ id: 'pagesetup', label: 'Page setup' },
			{ id: 'goals', label: 'Goals' },
			{ id: 'cover', label: 'Cover' },
			{ id: 'publish', label: 'Publish' },
			{ id: 'review', label: 'Review' },
			{ id: 'export', label: 'Export' },
			{ id: 'history', label: 'History' },
			{ id: 'danger', label: 'Danger zone' }
		]
			.filter((item) => item.id !== 'cover' || data.assetsConfigured)
			.filter((item) => item.id !== 'publish' || (data.archive?.enabled && data.archive?.handle))
	);
</script>

<svelte:window onpagehide={flushFocusedField} />

<svelte:head>
	<title>{data.story.title} - Settings - Codex</title>
</svelte:head>

<SettingsShell>
	{#snippet topbar()}
		<PageTopBar
			back={{ href: resolve('/stories/[id]', { id: data.story.slug }), label: data.story.title }}
			help={{ topic: helpTopic, label: 'story settings' }}
		/>
	{/snippet}
	{#snippet sidebar()}
		<div class="admin-sidebar-title">
			<span class="ic badge sm" style="background: {coverColor}; color: #fff;">
				{data.story.title.slice(0, 1).toUpperCase()}
			</span>
			<div>
				<div class="tt">{data.story.title}</div>
				<div class="st">{data.universe.name}</div>
			</div>
		</div>
		<!-- eslint-disable svelte/no-navigation-without-resolve (sectionHref wraps resolve) -->
		<nav class="admin-nav">
			<div class="admin-nav-label">Story settings</div>
			{#each NAV as item (item.id)}
				<a class="nav-item" class:active={active === item.id} href={sectionHref(item.id)}>
					{item.label}
				</a>
			{/each}
		</nav>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/snippet}

	<div class="admin-head">
		<p class="admin-eyebrow">{data.universe.name}</p>
		<h1 class="admin-title">Story settings</h1>
		<p class="admin-lede">Everything about "{data.story.title}" that is not its prose.</p>
	</div>

	<div class="admin-block" class:active={active === 'details'} id="details">
		<SettingsDetails {data} {form} />
	</div>

	<div class="admin-block" class:active={active === 'editor'} id="editor">
		<SettingsEditor {data} {form} />
	</div>

	<div class="admin-block" class:active={active === 'pagesetup'} id="pagesetup">
		<SettingsPageSetup {data} {form} />
	</div>

	<div class="admin-block" class:active={active === 'goals'} id="goals">
		<SettingsGoals {data} {form} />
	</div>

	{#if data.assetsConfigured}
		<div class="admin-block" class:active={active === 'cover'} id="cover">
			<SettingsCover {data} {form} />
		</div>
	{/if}

	{#if data.archive.enabled && data.archive.handle}
		<div class="admin-block" class:active={active === 'publish'} id="publish">
			<SettingsPublish {data} {form} />
		</div>
	{/if}

	<div class="admin-block" class:active={active === 'review'} id="review">
		<SettingsReview {data} {form} />
	</div>

	<div class="admin-block" class:active={active === 'export'} id="export">
		<SettingsExport {data} />
	</div>

	<div class="admin-block" class:active={active === 'history'} id="history">
		<SettingsHistory {data} />
	</div>

	<div class="admin-block danger-block" class:active={active === 'danger'} id="danger">
		<SettingsDanger />
	</div>
</SettingsShell>

<style>
	/* One section at a time; the URL picks which. The .admin-main wrapper is
	   rendered by SettingsShell, so it is global from this page's view. */
	:global(.admin-main) .admin-block:not(.active) {
		display: none;
	}

	.danger-block {
		border-color: color-mix(in oklab, var(--danger, #b00020) 35%, var(--border));
	}
	/* Anchor nav items reuse the admin nav button styling. */
	.admin-nav a.nav-item {
		text-decoration: none;
		display: flex;
		align-items: center;
	}
</style>
