<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { beforeNavigate } from '$app/navigation';
	import { flushFocusedField } from '$lib/autosave-form';
	import PageTopBar from '$lib/components/PageTopBar.svelte';
	import SettingsShell from '$lib/components/SettingsShell.svelte';
	import AccountProfile from './AccountProfile.svelte';
	import AccountSecurity from './AccountSecurity.svelte';
	import AccountAssistant from './AccountAssistant.svelte';
	import AccountDisplay from './AccountDisplay.svelte';
	import AccountEditor from './AccountEditor.svelte';
	import AccountNotifications from './AccountNotifications.svelte';
	import AccountPageSetup from './AccountPageSetup.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The preference forms (Display, Editor, Notifications, Page setup) save on
	// change instead of with a button; see $lib/autosave-form. Flushing a
	// focused field before navigation is page-level, across every section.
	beforeNavigate(flushFocusedField);

	type Section =
		'profile' | 'security' | 'assistant' | 'display' | 'editor' | 'notifications' | 'pagesetup';

	// Each section is its own page (/account/security, /account/display);
	// a plain /account is the profile. Forms post to the section they sit
	// on, so an action result lands where it belongs without any bookkeeping.
	let active: Section = $derived((page.params.section as Section) ?? 'profile');

	function sectionHref(section: Section): string {
		return resolve('/account/[[section]]', {
			section: section === 'profile' ? undefined : section
		});
	}

	// The sidebar avatar's letters.
	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		const first = parts[0]?.[0] ?? '';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase() || '?';
	}
</script>

<svelte:window onpagehide={flushFocusedField} />

<svelte:head>
	<title>Account - Codex</title>
</svelte:head>

<SettingsShell>
	{#snippet topbar()}
		<PageTopBar
			back={{ href: resolve('/'), label: 'Library' }}
			help={{
				topic: active === 'security' ? 'security' : 'account',
				label: active === 'security' ? 'account security' : 'your account'
			}}
		/>
	{/snippet}
	{#snippet sidebar()}
		<div class="admin-sidebar-title">
			<span
				class="ic"
				style="background:linear-gradient(140deg,var(--accent),color-mix(in oklab,var(--accent) 55%,#000));color:#fff;font-weight:700;font-size:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.2);"
				>{initials(data.displayName)}</span
			>
			<div>
				<div class="tt">{data.displayName}</div>
				<div class="st">{data.email}</div>
			</div>
		</div>

		<!-- eslint-disable svelte/no-navigation-without-resolve (sectionHref wraps resolve) -->
		<nav class="admin-nav">
			<div class="admin-nav-label">You</div>
			<a class="nav-item" class:active={active === 'profile'} href={sectionHref('profile')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg
				>
				<span class="lbl">Profile</span>
			</a>
			<a class="nav-item" class:active={active === 'security'} href={sectionHref('security')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><rect x="3" y="11" width="18" height="11" rx="2" /><path
						d="M7 11V7a5 5 0 0 1 10 0v4"
					/></svg
				>
				<span class="lbl">Security</span>
			</a>

			<div class="admin-nav-label">Workspace</div>
			<a class="nav-item" class:active={active === 'assistant'} href={sectionHref('assistant')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path
						d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4"
					/><circle cx="12" cy="12" r="4" /></svg
				>
				<span class="lbl">Assistant</span>
			</a>
			<a class="nav-item" class:active={active === 'display'} href={sectionHref('display')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><rect x="2" y="3" width="20" height="14" rx="2" /><line
						x1="8"
						y1="21"
						x2="16"
						y2="21"
					/><line x1="12" y1="17" x2="12" y2="21" /></svg
				>
				<span class="lbl">Display</span>
			</a>
			<a class="nav-item" class:active={active === 'editor'} href={sectionHref('editor')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg
				>
				<span class="lbl">Editor</span>
			</a>
			<a
				class="nav-item"
				class:active={active === 'notifications'}
				href={sectionHref('notifications')}
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path
						d="M13.7 21a2 2 0 0 1-3.4 0"
					/></svg
				>
				<span class="lbl">Notifications</span>
			</a>
			<a class="nav-item" class:active={active === 'pagesetup'} href={sectionHref('pagesetup')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path
						d="M14 2v6h6"
					/><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg
				>
				<span class="lbl">Page setup</span>
			</a>

			{#if data.isAdmin}
				<div class="admin-nav-label">Instance</div>
				<a class="nav-item nav-item-out" href={resolve('/admin/[[section]]', {})}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z" /></svg
					>
					<span class="lbl">Admin panel</span>
					<svg
						class="nav-out-arrow"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.9"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path
							d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"
						/></svg
					>
				</a>
			{/if}
		</nav>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->

		<div
			class="admin-health"
			style="background:transparent;box-shadow:none;border:0;padding:12px 4px 2px;"
		>
			<form method="POST" action={resolve('/logout')}>
				<button class="btn btn-secondary" type="submit" style="width:100%;justify-content:center;"
					>Sign out</button
				>
			</form>
		</div>
	{/snippet}

	<!-- ========== PROFILE ========== -->
	<section class="admin-section" class:active={active === 'profile'}>
		<AccountProfile {data} {form} />
	</section>

	<!-- ========== SECURITY ========== -->
	<section class="admin-section" class:active={active === 'security'}>
		<AccountSecurity {data} {form} />
	</section>

	<!-- ========== ASSISTANT ========== -->
	<section class="admin-section" class:active={active === 'assistant'}>
		<AccountAssistant {data} {form} />
	</section>

	<!-- ========== DISPLAY ========== -->
	<section class="admin-section" class:active={active === 'display'}>
		<AccountDisplay {data} {form} />
	</section>

	<!-- ========== EDITOR ========== -->
	<section class="admin-section" class:active={active === 'editor'}>
		<AccountEditor {data} {form} />
	</section>

	<!-- ========== NOTIFICATIONS ========== -->
	<section class="admin-section" class:active={active === 'notifications'}>
		<AccountNotifications {data} {form} />
	</section>

	<!-- ========== PAGE SETUP ========== -->
	<section class="admin-section" class:active={active === 'pagesetup'}>
		<AccountPageSetup {data} {form} />
	</section>
</SettingsShell>
