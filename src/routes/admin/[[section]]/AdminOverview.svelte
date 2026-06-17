<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Section } from './sections';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function sectionHref(section: Section): string {
		return resolve('/admin/[[section]]', {
			section: section === 'overview' ? undefined : section
		});
	}

	const pending = $derived(data.users.filter((u) => !u.approvedAt && u.role !== 'admin'));
	const liveEditions = $derived(data.published.filter((e) => !e.removedAt));
	const publishedCount = $derived(liveEditions.filter((e) => e.isCurrent).length);

	const lastBackup = $derived(data.backupRuns[0] ?? null);
	const emailReady = $derived(data.smtp.source !== 'none');

	// Conditions worth surfacing on the overview, newest concern first.
	type Attn = { tone: 'info' | 'warn' | 'ok'; title: string; sub: string; goto?: Section };
	const attention = $derived.by<Attn[]>(() => {
		const list: Attn[] = [];
		if (pending.length > 0) {
			list.push({
				tone: 'info',
				title: `${pending.length} ${pending.length === 1 ? 'person is' : 'people are'} waiting for access`,
				sub: 'Approving creates their library and lets them sign in, even before their email is confirmed.',
				goto: 'users'
			});
		}
		if (!data.backupsConfigured) {
			list.push({
				tone: 'warn',
				title: 'Off-site backups are not configured',
				sub: 'Point the backups section at a bucket so the worker can take hourly dumps.',
				goto: 'backups'
			});
		} else if (lastBackup && lastBackup.status === 'failed') {
			list.push({
				tone: 'warn',
				title: 'The last backup failed',
				sub: lastBackup.error ?? 'Check the worker log for details.',
				goto: 'backups'
			});
		}
		if (data.assetStorage.source === 'none') {
			list.push({
				tone: 'warn',
				title: 'Asset storage is not configured',
				sub: 'Image uploads, covers, avatars, and edition downloads stay hidden until a bucket is set under Usage & storage.',
				goto: 'usage'
			});
		}
		if (!emailReady) {
			list.push({
				tone: 'warn',
				title: 'Email is not configured',
				sub: 'Until a relay is set, verification and reset emails are written to the worker log instead of sent.',
				goto: 'instance'
			});
		}
		if (list.length === 0) {
			list.push({
				tone: 'ok',
				title: 'Everything looks healthy',
				sub: 'No accounts are waiting, and backups, asset storage, and email are all set up.'
			});
		}
		return list;
	});
</script>

<div class="admin-head">
	<div class="admin-head-top">
		<div>
			<p class="admin-eyebrow">Instance</p>
			<h1 class="admin-title">Overview</h1>
		</div>
	</div>
	<p class="admin-lede">Everything on this Codex instance, at a glance.</p>
</div>

<div class="admin-block">
	<div class="admin-stat-grid">
		<div class="admin-stat">
			<div class="admin-stat-top">
				<span class="admin-stat-label">Active writers</span>
			</div>
			<div class="admin-stat-n">{data.stats.writers}</div>
			<div class="admin-stat-foot">
				{#if data.stats.pending > 0}<span class="delta up">+{data.stats.pending}</span> awaiting approval{:else}<span
						class="delta flat">none</span
					> awaiting approval{/if}
			</div>
		</div>
		<div class="admin-stat">
			<div class="admin-stat-top"><span class="admin-stat-label">Universes</span></div>
			<div class="admin-stat-n">{data.stats.universes}</div>
			<div class="admin-stat-foot">
				<span class="delta flat">{data.stats.stories}</span> stories total
			</div>
		</div>
		<div class="admin-stat">
			<div class="admin-stat-top">
				<span class="admin-stat-label">Published editions</span>
			</div>
			<div class="admin-stat-n">{publishedCount}</div>
			<div class="admin-stat-foot">
				<span class="delta flat">current</span> on public pages
			</div>
		</div>
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">
			Needs attention <span class="n">{attention.length}</span>
		</h2>
	</div>
	<div class="admin-card tight">
		<div class="attn-list">
			{#each attention as item (item.title)}
				<div class="attn-row">
					<span class="attn-ic {item.tone}">
						{#if item.tone === 'ok'}
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
								><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline
									points="22 4 12 14.01 9 11.01"
								/></svg
							>
						{:else if item.tone === 'warn'}
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
								><path
									d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
								/><line x1="12" y1="9" x2="12" y2="13" /><line
									x1="12"
									y1="17"
									x2="12"
									y2="17"
								/></svg
							>
						{:else}
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
								><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle
									cx="9"
									cy="7"
									r="4"
								/><line x1="19" y1="8" x2="19" y2="14" /><line
									x1="22"
									y1="11"
									x2="16"
									y2="11"
								/></svg
							>
						{/if}
					</span>
					<div class="attn-body">
						<p class="attn-title">{item.title}</p>
						<p class="attn-sub">{item.sub}</p>
					</div>
					{#if item.goto}
						<div class="attn-actions">
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (sectionHref wraps resolve) -->
							<a class="btn btn-secondary btn-sm" href={sectionHref(item.goto)}>Open</a>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>
