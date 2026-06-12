<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import NotificationBell from './NotificationBell.svelte';
	import UserMenu from './UserMenu.svelte';
	import HelpLink from './HelpLink.svelte';
	import PaletteButton from './PaletteButton.svelte';

	// The top bar shared by the static pages (library, account, settings,
	// admin). The editor and planning pages keep their own TopBar, which is
	// built around the universe/story breadcrumb.
	let {
		back,
		help
	}: {
		// Where the back link leads and what it says; the library has none.
		back?: { href: string; label: string };
		// The help topic for this page, shown as a "?" in the bar.
		help?: { topic: string; label: string };
	} = $props();
</script>

<header class="topbar">
	<a class="brand" href={resolve('/')}>
		<span class="brand-mark" style="color: #fff"><Icon name="feather" size={15} /></span>
		<span class="brand-name">Codex</span>
	</a>
	{#if back}
		<span class="divider"></span>
		<!-- eslint-disable svelte/no-navigation-without-resolve (callers pass resolved paths) -->
		<a class="back-link" href={back.href}>
			<svg
				viewBox="0 0 12 12"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"><polyline points="7.5 2.5 3 6 7.5 9.5" /></svg
			>
			{back.label}
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}
	<span class="spacer"></span>
	<PaletteButton />
	<NotificationBell />
	{#if help}
		<HelpLink topic={help.topic} label={help.label} />
	{/if}
	<UserMenu />
</header>
