<script lang="ts">
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';

	let {
		universe,
		story,
		initials
	}: {
		universe: { id: string; name: string };
		story: { id: string; title: string };
		initials: string;
	} = $props();

	// Initialised from the attribute the app.html inline script set; reassigned
	// by the toggle (writable derived).
	let theme = $derived<'light' | 'dark'>(
		browser && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
	);

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		document.documentElement.setAttribute('data-theme', theme);
		try {
			localStorage.setItem('codex-theme', theme);
		} catch {
			/* preference just does not persist */
		}
	}
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
		<button class="icon-btn" type="button" title="Toggle theme" onclick={toggleTheme}>
			{#if theme === 'dark'}<Icon name="sun" />{:else}<Icon name="moon" />{/if}
		</button>
		<a
			class="icon-btn"
			href={resolve('/universes/[id]', { id: universe.id })}
			title="Universe settings"
		>
			<Icon name="gear" />
		</a>
		<a class="avatar-me" href={resolve('/')} title="Account">{initials}</a>
	</div>
</header>
