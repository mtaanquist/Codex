<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import CrumbMenu from './CrumbMenu.svelte';
	import NotificationBell from './NotificationBell.svelte';
	import UserMenu from './UserMenu.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import { openPalette } from '$lib/palette.svelte';
	import { helpReturn, rememberLocation } from '$lib/help.svelte';
	import { authorInitials } from '$lib/review-ui';
	import type { Crumb } from '$lib/chrome';

	// The one navigation bar: brand, path, tools, in that order, on every page.
	// Three shells share it. A shell may drop a tool; none reorders one, and
	// none adds a second bar.
	let {
		shell = 'author',
		crumbs,
		pathLabel = 'Where you are',
		saveStatus = 'idle',
		helpTopic,
		helpLabel = 'Help',
		pill,
		byline,
		who
	}: {
		// author: the signed-in writer. guest: an invited reviewer.
		// reader: the public reading pages.
		shell?: 'author' | 'guest' | 'reader';
		crumbs: Crumb[];
		pathLabel?: string;
		saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
		// The help article this page is about; the tool opens it.
		helpTopic?: string;
		helpLabel?: string;
		// A status label beside the path, such as "Review only".
		pill?: string;
		// Trailing plain text in the path, such as "by Kera Eressea".
		byline?: string;
		// Who a guest is reviewing as.
		who?: string;
	} = $props();

	const SAVE_LABEL = {
		idle: '',
		saving: 'Saving...',
		saved: 'Saved just now',
		error: 'Not saved. Retrying on your next change.'
	} as const;

	const onHelp = $derived(page.url.pathname.startsWith('/docs'));
	const home = resolve('/');
	// Pressing the lit question mark again returns to the page you left.
	const helpHref = $derived(
		onHelp
			? helpReturn(home)
			: helpTopic
				? resolve('/docs/[topic]', { topic: helpTopic })
				: resolve('/docs')
	);
	const helpTitle = $derived(onHelp ? 'Help is open. Go back to your work.' : `Help: ${helpLabel}`);

	// Remember where the question mark should bring you back to.
	$effect(() => {
		if (!onHelp) rememberLocation(page.url.pathname + page.url.search);
	});
</script>

<header class="appbar" class:guest={shell === 'guest'} class:reader={shell === 'reader'}>
	{#if shell === 'guest'}
		<span class="appbar-brand">
			<span class="logo"><Icon name="feather" size={15} /></span>
			<span class="brand-name">Codex</span>
		</span>
	{:else}
		<a class="appbar-brand" href={home} aria-label="Codex, your library">
			<span class="logo"><Icon name="feather" size={15} /></span>
			<span class="brand-name">Codex</span>
		</a>
	{/if}
	<span class="appbar-rule"></span>

	<!-- eslint-disable svelte/no-navigation-without-resolve (chrome.ts resolves every href) -->
	<nav class="path" aria-label={pathLabel}>
		{#each crumbs as crumb, index (index)}
			{#if index > 0}
				<span class="crumb-sep" aria-hidden="true"><Icon name="chevron" /></span>
			{/if}
			{#if crumb.kind === 'link'}
				<a class="crumb" href={crumb.href}>{crumb.label}</a>
			{:else if crumb.kind === 'text'}
				<span class="crumb current" aria-current="page">{crumb.label}</span>
			{:else}
				<CrumbMenu label={crumb.label} current={crumb.current} groups={crumb.groups} />
			{/if}
		{/each}
		{#if pill}<span class="pill">{pill}</span>{/if}
		{#if byline}<span class="appbar-by">{byline}</span>{/if}
	</nav>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->

	<div class="appbar-tools">
		{#if saveStatus !== 'idle'}
			<span class="saved" role="status"><span class="dot"></span> {SAVE_LABEL[saveStatus]}</span>
		{/if}
		{#if shell === 'author' && page.data.user}
			<button
				class="tool-search"
				type="button"
				title="Search and commands (Ctrl+K)"
				aria-label="Search and commands"
				onclick={openPalette}
			>
				<Icon name="search" />
				Search <kbd>Ctrl K</kbd>
			</button>
		{/if}
		<ThemeToggle />
		<!-- A tool that is a place, not a popup: resolve() covers the help
		     pages, and the way back is a location this app already visited. -->
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a
			class="icon-btn help"
			href={helpHref}
			title={helpTitle}
			aria-label={helpTitle}
			aria-current={onHelp ? 'page' : undefined}
		>
			?
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{#if shell === 'author'}
			<NotificationBell />
			<UserMenu />
		{/if}
		{#if who}
			<span class="appbar-who">
				<span class="avatar">{authorInitials(who)}</span>
				Reviewing as {who}
			</span>
		{/if}
	</div>
</header>

<style>
	/* The reader shell names the author beside the story; the rest of the path
	   is the shared crumb machinery. */
	.appbar-by {
		font-size: var(--text-sm);
		color: var(--text-muted);
		white-space: nowrap;
	}
	/* The brand mark is a filled tile, so its stroke icon is always white. */
	.logo :global(svg) {
		color: #fff;
	}
	/* The guest shell shows who, not a menu, so the mark is not a button. */
	.appbar-who .avatar {
		cursor: default;
	}
</style>
