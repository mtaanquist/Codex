<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	let {
		universe,
		story,
		initials,
		onEnterFocus,
		saveStatus = 'idle',
		storyView
	}: {
		universe: { id: string; name: string };
		story: { id: string; title: string };
		initials: string;
		onEnterFocus?: () => void;
		saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
		storyView?: { active: boolean; toggleHref: string };
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
		<a class="crumb" href={resolve('/universes/[id]', { id: universe.id })}>{universe.name}</a>
		<span class="sep"><Icon name="chevron" size={13} /></span>
		<a class="crumb current" href={resolve('/stories/[id]/settings', { id: story.id })}>
			{story.title}
		</a>
	</nav>
	<div class="topbar-right">
		{#if saveStatus !== 'idle'}
			<span class="saved" role="status"><span class="dot"></span> {SAVE_LABEL[saveStatus]}</span>
		{/if}
		<ThemeToggle />
		<a
			class="icon-btn"
			href={resolve('/universes/[id]', { id: universe.id })}
			title="Universe settings"
		>
			<Icon name="gear" />
		</a>
		{#if storyView}
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a
				class="icon-btn"
				href={storyView.toggleHref}
				title={storyView.active ? 'Back to the scene editor' : 'Read the whole story'}
			>
				<Icon name={storyView.active ? 'scene' : 'chapter'} />
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
		{#if onEnterFocus}
			<button class="icon-btn" type="button" title="Focus mode" onclick={onEnterFocus}>
				<Icon name="expand" />
			</button>
		{/if}
		<a class="avatar-me" href={resolve('/')} title="Account">{initials}</a>
	</div>
</header>
