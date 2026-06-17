<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import PageTopBar from '$lib/components/PageTopBar.svelte';
	import SettingsShell from '$lib/components/SettingsShell.svelte';
	import type { Section } from './sections';
	import type { ActionData, PageData } from './$types';
	import AdminOverview from './AdminOverview.svelte';
	import AdminUsers from './AdminUsers.svelte';
	import AdminAi from './AdminAi.svelte';
	import AdminUsage from './AdminUsage.svelte';
	import AdminPublished from './AdminPublished.svelte';
	import AdminBackups from './AdminBackups.svelte';
	import AdminAudit from './AdminAudit.svelte';
	import AdminInstance from './AdminInstance.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Each section is its own page (/admin/users, /admin/backups, ...);
	// a plain /admin is the overview. Forms post to the section they sit on,
	// so an action result lands where it belongs without any bookkeeping.
	let active: Section = $derived((page.params.section as Section) ?? 'overview');

	function sectionHref(section: Section): string {
		return resolve('/admin/[[section]]', {
			section: section === 'overview' ? undefined : section
		});
	}

	const pending = $derived(data.users.filter((u) => !u.approvedAt && u.role !== 'admin'));
	const emailReady = $derived(data.smtp.source !== 'none');
</script>

<svelte:head>
	<title>Site admin - Codex</title>
</svelte:head>

<SettingsShell>
	{#snippet topbar()}
		<PageTopBar back={{ href: resolve('/'), label: 'Library' }} />
	{/snippet}
	{#snippet sidebar()}
		<div class="admin-sidebar-title">
			<span class="ic">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z" /></svg
				>
			</span>
			<div>
				<div class="tt">Administration</div>
				<div class="st">Codex instance</div>
			</div>
		</div>

		<!-- eslint-disable svelte/no-navigation-without-resolve (sectionHref wraps resolve) -->
		<nav class="admin-nav">
			<div class="admin-nav-label">Instance</div>
			<a class="nav-item" class:active={active === 'overview'} href={sectionHref('overview')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><rect x="3" y="3" width="7" height="9" rx="1" /><rect
						x="14"
						y="3"
						width="7"
						height="5"
						rx="1"
					/><rect x="14" y="12" width="7" height="9" rx="1" /><rect
						x="3"
						y="16"
						width="7"
						height="5"
						rx="1"
					/></svg
				>
				<span class="lbl">Overview</span>
			</a>
			<a class="nav-item" class:active={active === 'users'} href={sectionHref('users')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path
						d="M22 21v-2a4 4 0 0 0-3-3.87"
					/><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg
				>
				<span class="lbl">Users &amp; access</span>
				{#if pending.length > 0}<span class="nav-badge">{pending.length}</span>{/if}
			</a>
			<a class="nav-item" class:active={active === 'ai'} href={sectionHref('ai')}>
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
				<span class="lbl">AI</span>
			</a>

			<div class="admin-nav-label">Data</div>
			<a class="nav-item" class:active={active === 'usage'} href={sectionHref('usage')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" rx="0.5" /><rect
						x="12.5"
						y="7"
						width="3"
						height="10"
						rx="0.5"
					/><rect x="18" y="13" width="3" height="4" rx="0.5" /></svg
				>
				<span class="lbl">Usage &amp; storage</span>
				<span class="nav-badge muted">soon</span>
			</a>
			<a class="nav-item" class:active={active === 'published'} href={sectionHref('published')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path
						d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"
					/></svg
				>
				<span class="lbl">Published</span>
			</a>
			<a class="nav-item" class:active={active === 'backups'} href={sectionHref('backups')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><ellipse cx="12" cy="5" rx="8" ry="3" /><path
						d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"
					/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" /></svg
				>
				<span class="lbl">Backups</span>
				{#if !data.backupsConfigured}<span class="nav-badge muted">!</span>{/if}
			</a>
			<a class="nav-item" class:active={active === 'audit'} href={sectionHref('audit')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M3 12h4l2 5 4-12 2 7h6" /></svg
				>
				<span class="lbl">Audit log</span>
				<span class="nav-badge muted">soon</span>
			</a>

			<div class="admin-nav-label">Configuration</div>
			<a class="nav-item" class:active={active === 'instance'} href={sectionHref('instance')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M4 4h16v16H4z" fill="none" /><path d="m22 6-10 7L2 6" /><rect
						x="2"
						y="4"
						width="20"
						height="16"
						rx="2"
					/></svg
				>
				<span class="lbl">Email relay</span>
			</a>
		</nav>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->

		<div class="admin-health">
			<div class="admin-health-row">
				<span class="dot" class:ok={data.backupsConfigured} class:warn={!data.backupsConfigured}
				></span>
				<span class="k">Backups</span>
				<span class="v">{data.backupsConfigured ? 'On' : 'Off'}</span>
			</div>
			<div class="admin-health-row">
				<span class="dot" class:ok={emailReady} class:warn={!emailReady}></span>
				<span class="k">Email relay</span>
				<span class="v">{emailReady ? 'Configured' : 'Console'}</span>
			</div>
			<div class="admin-health-meta">codex v{data.version} · up {data.uptime}</div>
		</div>
	{/snippet}

	<!-- ========== OVERVIEW ========== -->
	<section class="admin-section" class:active={active === 'overview'}>
		<AdminOverview {data} />
	</section>

	<!-- ========== USERS & ACCESS ========== -->
	<section class="admin-section" class:active={active === 'users'}>
		<AdminUsers {data} {form} />
	</section>

	<!-- ========== AI (stub) ========== -->
	<section class="admin-section" class:active={active === 'ai'}>
		<AdminAi {data} {form} />
	</section>

	<!-- ========== USAGE & STORAGE ========== -->
	<section class="admin-section" class:active={active === 'usage'}>
		<AdminUsage {data} {form} />
	</section>

	<!-- ========== PUBLISHED ========== -->
	<section class="admin-section" class:active={active === 'published'}>
		<AdminPublished {data} {form} />
	</section>

	<!-- ========== BACKUPS ========== -->
	<section class="admin-section" class:active={active === 'backups'}>
		<AdminBackups {data} {form} />
	</section>

	<!-- ========== AUDIT (stub) ========== -->
	<section class="admin-section" class:active={active === 'audit'}>
		<AdminAudit />
	</section>

	<!-- ========== EMAIL RELAY (SMTP) ========== -->
	<section class="admin-section" class:active={active === 'instance'}>
		<AdminInstance {data} {form} />
	</section>
</SettingsShell>
