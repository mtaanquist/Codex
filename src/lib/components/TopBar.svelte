<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	let {
		universe,
		story,
		initials,
		onEnterFocus
	}: {
		universe: { id: string; name: string };
		story: { id: string; title: string };
		initials: string;
		onEnterFocus?: () => void;
	} = $props();
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
		<ThemeToggle />
		<a
			class="icon-btn"
			href={resolve('/universes/[id]', { id: universe.id })}
			title="Universe settings"
		>
			<Icon name="gear" />
		</a>
		{#if onEnterFocus}
			<button class="icon-btn" type="button" title="Focus mode" onclick={onEnterFocus}>
				<Icon name="expand" />
			</button>
		{/if}
		<a class="avatar-me" href={resolve('/')} title="Account">{initials}</a>
	</div>
</header>
