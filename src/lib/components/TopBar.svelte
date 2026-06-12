<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import NotificationBell from './NotificationBell.svelte';
	import UserMenu from './UserMenu.svelte';
	import HelpLink from './HelpLink.svelte';
	import PaletteButton from './PaletteButton.svelte';

	let {
		universe,
		story,
		saveStatus = 'idle',
		help
	}: {
		universe: { slug: string; name: string };
		// Absent on universe-scoped pages; the universe becomes the crumb.
		story?: { slug: string; title: string };
		saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
		// The help topic for this page, shown as a "?" in the bar.
		help?: { topic: string; label: string };
	} = $props();

	const SAVE_LABEL = {
		idle: '',
		saving: 'Saving...',
		saved: 'Saved just now',
		error: 'Not saved. Retrying on your next change.'
	} as const;
</script>

<header class="topbar">
	<a class="brand" href={resolve('/')} title="Library">
		<span class="brand-mark" style="color: #fff"><Icon name="feather" size={15} /></span>
		<span class="brand-name">Codex</span>
	</a>
	<nav class="crumbs">
		<a class="crumb" href={resolve('/')}>Library</a>
		<span class="sep"><Icon name="chevron" size={13} /></span>
		{#if story}
			<a class="crumb" href={resolve('/universes/[id]/plan', { id: universe.slug })}>
				{universe.name}
			</a>
			<span class="sep"><Icon name="chevron" size={13} /></span>
			<a
				class="crumb current"
				href={resolve('/stories/[id]/settings/[[section]]', { id: story.slug })}
				title="Story settings"
			>
				{story.title}
			</a>
		{:else}
			<a class="crumb current" href={resolve('/universes/[id]/[[section]]', { id: universe.slug })}>
				{universe.name}
			</a>
		{/if}
	</nav>
	<div class="topbar-right">
		{#if saveStatus !== 'idle'}
			<span class="saved" role="status"><span class="dot"></span> {SAVE_LABEL[saveStatus]}</span>
		{/if}
		<PaletteButton />
		<!-- The gear opens the settings of what is on screen: the story's when
		     one is open, the universe's otherwise. -->
		{#if story}
			<a
				class="icon-btn"
				href={resolve('/stories/[id]/settings/[[section]]', { id: story.slug })}
				title="Story settings"
			>
				<Icon name="gear" />
			</a>
		{:else}
			<a
				class="icon-btn"
				href={resolve('/universes/[id]/[[section]]', { id: universe.slug })}
				title="Universe settings"
			>
				<Icon name="gear" />
			</a>
		{/if}
		<NotificationBell />
		{#if help}
			<HelpLink topic={help.topic} label={help.label} />
		{/if}
		<UserMenu />
	</div>
</header>
