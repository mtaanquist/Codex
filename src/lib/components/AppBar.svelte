<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import CrumbMenu from './CrumbMenu.svelte';
	import NotificationBell from './NotificationBell.svelte';
	import UserMenu from './UserMenu.svelte';
	import ThemePicker from './ThemePicker.svelte';
	import { openPalette } from '#lib/palette.svelte';
	import { helpReturn, rememberLocation } from '#lib/help.svelte';
	import { authorInitials } from '#lib/review-ui';
	import { modLabel } from '#lib/keys';
	import { onMount } from 'svelte';
	import type { Crumb } from '#lib/chrome';

	// The one navigation bar: brand, path, tools, in that order, on every page.
	// Four shells share it. A shell may drop a tool; none reorders one, and
	// none adds a second bar.
	let {
		shell = 'author',
		crumbs = [],
		pathLabel = 'Where you are',
		saveStatus = 'idle',
		helpTopic,
		helpLabel = 'Help',
		pill,
		byline,
		who
	}: {
		// author: the signed-in writer. guest: an invited reviewer.
		// reader: the public reading pages. public: the signed-out pages, which
		// carry no path because a visitor is not anywhere in the library yet.
		shell?: 'author' | 'guest' | 'reader' | 'public';
		crumbs?: Crumb[];
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

	// A narrow bar keeps the current place, plus its parent when the current
	// crumb is a page (plain text) and so leads nowhere on its own.
	const narrowFrom = $derived(
		crumbs.length > 1 && crumbs[crumbs.length - 1].kind === 'text'
			? crumbs.length - 2
			: crumbs.length - 1
	);

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
		// The current page's own URL, so it already carries the base path.
		if (!onHelp) rememberLocation((page.url.pathname + page.url.search) as ResolvedPathname);
	});

	// SSR cannot know the platform, so the modifier label settles after mount.
	let mod = $state<'Cmd' | 'Ctrl'>('Ctrl');
	onMount(() => (mod = modLabel()));
</script>

<header
	class="appbar"
	class:guest={shell === 'guest'}
	class:reader={shell === 'reader'}
	class:public={shell === 'public'}
>
	{#if shell === 'guest'}
		<span class="appbar-brand">
			<span class="logo"><Icon name="feather" size={15} /></span>
			<span class="brand-name">Codex</span>
		</span>
	{:else}
		<a
			class="appbar-brand"
			href={home}
			aria-label={shell === 'public' ? 'Codex, home' : 'Codex, your library'}
		>
			<span class="logo"><Icon name="feather" size={15} /></span>
			<span class="brand-name">Codex</span>
		</a>
	{/if}

	<!-- A signed-out visitor is not anywhere in the library, so the public bar
	     carries no path and no rule to divide one from the brand. -->
	{#if shell !== 'public'}
		<span class="appbar-rule"></span>

		<nav class="path" aria-label={pathLabel}>
			{#each crumbs as crumb, index (index)}
				<!-- Marked so a narrow bar can drop the crumbs before narrowFrom. -->
				<span
					class="crumb-item"
					class:narrow-hide={index < narrowFrom}
					class:narrow-first={index === narrowFrom}
				>
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
				</span>
			{/each}
			{#if pill}<span class="pill">{pill}</span>{/if}
			{#if byline}<span class="appbar-by">{byline}</span>{/if}
		</nav>
	{/if}

	<div class="appbar-tools">
		{#if saveStatus !== 'idle'}
			<span class="saved" role="status"><span class="dot"></span> {SAVE_LABEL[saveStatus]}</span>
		{/if}
		{#if shell === 'author' && page.data.user}
			<button
				class="tool-search"
				type="button"
				title="Search and commands ({mod}+K)"
				aria-label="Search and commands"
				onclick={openPalette}
			>
				<Icon name="search" />
				<span class="tool-search-label">Search <kbd>{mod} K</kbd></span>
			</button>
		{/if}
		<!-- The author's theme lives in the account menu; the other bars have
		     no account menu, so they keep a picker of their own. -->
		{#if shell !== 'author'}
			<ThemePicker />
		{/if}
		<!-- A tool that is a place, not a popup: resolve() covers the help
		     pages, and the way back is a location this app already visited. -->
		<a
			class="icon-btn help"
			href={helpHref}
			title={helpTitle}
			aria-label={helpTitle}
			aria-current={onHelp ? 'page' : undefined}
		>
			?
		</a>
		{#if shell === 'author'}
			<NotificationBell />
			<UserMenu />
		{/if}
		{#if who}
			<span class="appbar-who">
				<span class="avatar">{authorInitials(who)}</span>
				<span class="appbar-who-label">Reviewing as {who}</span>
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
	/* The brand mark is a filled tile, so its icon uses --accent-contrast. */
	.logo :global(svg) {
		color: var(--accent-contrast);
	}
	/* The guest shell shows who, not a menu, so the mark is not a button. */
	.appbar-who .avatar {
		cursor: default;
	}
</style>
