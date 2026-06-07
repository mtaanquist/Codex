<script lang="ts">
	import { resolve } from '$app/paths';
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import PageTopBar from '$lib/components/PageTopBar.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const SECTIONS = [
		'overview',
		'users',
		'ai',
		'usage',
		'published',
		'backups',
		'audit',
		'instance'
	] as const;
	type Section = (typeof SECTIONS)[number];

	function sectionFromUrl(url: URL): Section | null {
		const s = url.searchParams.get('section');
		return SECTIONS.includes(s as Section) ? (s as Section) : null;
	}

	// After an action, jump to the section that owns the result so the admin
	// sees the message where it belongs.
	function sectionFor(scope: string | undefined): Section | null {
		switch (scope) {
			case 'accounts':
			case 'invites':
			case 'signup':
				return 'users';
			case 'published':
				return 'published';
			case 'backups':
				return 'backups';
			case 'storage':
				return 'usage';
			case 'smtp':
				return 'instance';
			default:
				return null;
		}
	}

	// The section rides in the URL (?section=users) so links, refreshes, and
	// the command palette land on the right one; a plain /admin is the
	// overview. The effects move to the section a navigation or an action
	// result points at.
	let active: Section = $derived(sectionFromUrl(page.url) ?? 'overview');
	// An action result overrides the URL: the forms here post natively, so the
	// page reloads without ?section= and only form.scope knows where the admin
	// was.
	$effect(() => {
		const s = sectionFor(form?.scope);
		if (s) active = s;
	});

	function go(section: Section) {
		active = section;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- stays on /admin, only the query changes
		pushState(`?section=${section}`, {});
	}

	// The sign-up policy choices, in order from closed to open.
	const SIGNUP_OPTIONS = [
		{
			value: 'none',
			name: 'No one',
			desc: 'Sign-up is closed. Only existing accounts can sign in, and invite codes stop working.'
		},
		{
			value: 'invite',
			name: 'Invite only',
			desc: 'Creating an account needs a valid invite code. Codes are made further down this page.'
		},
		{
			value: 'approval',
			name: 'Require approval',
			desc: 'Anyone can ask for an account; an admin approves each one before it can sign in. An invite code skips the wait.'
		},
		{
			value: 'open',
			name: 'Open',
			desc: 'Anyone can create an account and sign in once their email is confirmed.'
		}
	] as const;

	function when(date: Date | string): string {
		return new Date(date).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		const first = parts[0]?.[0] ?? '';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase() || '?';
	}

	function userStatus(u: PageData['users'][number]): string {
		if (u.deletionScheduledAt) return 'Deletion scheduled';
		if (u.suspendedAt) return 'Suspended';
		if (!u.approvedAt) return u.emailVerifiedAt ? 'Awaiting approval' : 'Email unconfirmed';
		// Approved before approval started waiving the check, or an invite
		// sign-up whose verification mail never arrived: cannot sign in yet.
		if (!u.emailVerifiedAt) return 'Email unconfirmed';
		return 'Active';
	}

	function inviteStatus(code: PageData['inviteCodes'][number]): string {
		if (code.usedCount >= code.maxUses) return 'Used up';
		if (code.expiresAt && new Date(code.expiresAt) < new Date()) return 'Expired';
		return 'Active';
	}

	// Briefly marks a row after its sign-up link is copied.
	let copiedInviteId = $state<string | null>(null);
	function copyInviteLink(code: PageData['inviteCodes'][number]) {
		const link = `${location.origin}/signup?code=${encodeURIComponent(code.code)}`;
		navigator.clipboard.writeText(link).then(() => {
			copiedInviteId = code.id;
			setTimeout(() => {
				if (copiedInviteId === code.id) copiedInviteId = null;
			}, 1500);
		});
	}

	const pending = $derived(data.users.filter((u) => !u.approvedAt && u.role !== 'admin'));
	const activeUsers = $derived(data.users.filter((u) => u.approvedAt || u.role === 'admin'));
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
				sub: 'No accounts are waiting, backups are configured, and email is set up.'
			});
		}
		return list;
	});
</script>

<svelte:head>
	<title>Site admin - Codex</title>
</svelte:head>

<!-- The S3 connection fields shared by the backup and asset storage forms. -->
{#snippet s3Fields(idPrefix: string, view: PageData['assetStorage'])}
	<div class="field-grid">
		<div class="field">
			<label for="{idPrefix}-endpoint">Endpoint</label>
			<input
				id="{idPrefix}-endpoint"
				class="input"
				type="text"
				name="endpoint"
				value={view.endpoint}
				placeholder="https://s3.us-west-004.backblazeb2.com"
			/>
		</div>
		<div class="field">
			<label for="{idPrefix}-region">Region</label>
			<input
				id="{idPrefix}-region"
				class="input"
				type="text"
				name="region"
				value={view.region}
				placeholder="auto"
			/>
		</div>
	</div>
	<div class="field-grid">
		<div class="field">
			<label for="{idPrefix}-bucket">Bucket</label>
			<input id="{idPrefix}-bucket" class="input" type="text" name="bucket" value={view.bucket} />
		</div>
		<div class="field">
			<label for="{idPrefix}-prefix">Key prefix</label>
			<input id="{idPrefix}-prefix" class="input" type="text" name="prefix" value={view.prefix} />
		</div>
	</div>
	<div class="field">
		<label for="{idPrefix}-access">Access key id</label>
		<input
			id="{idPrefix}-access"
			class="input"
			type="text"
			name="accessKeyId"
			value={view.accessKeyId}
			autocomplete="off"
		/>
	</div>
	<div class="field">
		<label for="{idPrefix}-secret">Secret access key</label>
		<input
			id="{idPrefix}-secret"
			class="input"
			type="password"
			name="secretAccessKey"
			autocomplete="off"
			placeholder={view.hasSecret ? 'Leave blank to keep the current key' : ''}
		/>
	</div>
{/snippet}

<div class="page-shell">
	<PageTopBar back={{ href: resolve('/'), label: 'Library' }} />

	<div class="admin-shell">
		<aside class="admin-sidebar">
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

			<nav class="admin-nav">
				<div class="admin-nav-label">Instance</div>
				<button
					class="nav-item"
					class:active={active === 'overview'}
					onclick={() => go('overview')}
				>
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
				</button>
				<button class="nav-item" class:active={active === 'users'} onclick={() => go('users')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle
							cx="9"
							cy="7"
							r="4"
						/><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg
					>
					<span class="lbl">Users &amp; access</span>
					{#if pending.length > 0}<span class="nav-badge">{pending.length}</span>{/if}
				</button>
				<button class="nav-item" class:active={active === 'ai'} onclick={() => go('ai')}>
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
					<span class="nav-badge muted">soon</span>
				</button>

				<div class="admin-nav-label">Data</div>
				<button class="nav-item" class:active={active === 'usage'} onclick={() => go('usage')}>
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
				</button>
				<button
					class="nav-item"
					class:active={active === 'published'}
					onclick={() => go('published')}
				>
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
				</button>
				<button class="nav-item" class:active={active === 'backups'} onclick={() => go('backups')}>
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
				</button>
				<button class="nav-item" class:active={active === 'audit'} onclick={() => go('audit')}>
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
				</button>

				<div class="admin-nav-label">Configuration</div>
				<button
					class="nav-item"
					class:active={active === 'instance'}
					onclick={() => go('instance')}
				>
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
				</button>
			</nav>

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
		</aside>

		<main class="admin-main page-body">
			<div class="admin-main-inner">
				<!-- ========== OVERVIEW ========== -->
				<section class="admin-section" class:active={active === 'overview'}>
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
									{#if data.stats.pending > 0}<span class="delta up">+{data.stats.pending}</span> awaiting
										approval{:else}<span class="delta flat">none</span> awaiting approval{/if}
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
												<button class="btn btn-secondary btn-sm" onclick={() => go(item.goto!)}
													>Open</button
												>
											</div>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					</div>
				</section>

				<!-- ========== USERS & ACCESS ========== -->
				<section class="admin-section" class:active={active === 'users'}>
					<div class="admin-head">
						<div class="admin-head-top">
							<div>
								<p class="admin-eyebrow">Instance</p>
								<h1 class="admin-title">Users &amp; access</h1>
							</div>
						</div>
						<p class="admin-lede">
							Everyone who can sign in, who is waiting, and what they are allowed to do.
						</p>
					</div>

					{#if form?.scope === 'accounts' && form.message}
						<div
							class="status-banner"
							style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
						>
							<span class="x">{form.message}</span>
						</div>
					{/if}

					<div class="admin-block">
						<div class="admin-block-head">
							<div>
								<h2 class="admin-block-title">Sign-up</h2>
								<p class="admin-block-sub">Who can create an account on this instance.</p>
							</div>
						</div>

						{#if form?.scope === 'signup' && form.message}
							<div
								class="status-banner"
								style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);margin-bottom:var(--space-4);"
							>
								<span class="x">{form.message}</span>
							</div>
						{:else if form?.scope === 'signup' && form.saved}
							<div class="status-banner ok" style="margin-bottom:var(--space-4);">
								<span class="dot"></span><span class="v">Saved.</span>
							</div>
						{/if}

						<form method="POST" action="?/saveSignup">
							<div class="policy-grid">
								{#each SIGNUP_OPTIONS as option (option.value)}
									<label class="policy-card">
										<input
											type="radio"
											name="mode"
											value={option.value}
											checked={data.signup === option.value}
										/>
										<span class="policy-radio"></span>
										<div>
											<div class="policy-name">{option.name}</div>
											<div class="policy-desc">{option.desc}</div>
										</div>
									</label>
								{/each}
							</div>
							<div class="settings-actions">
								<button type="submit" class="btn btn-primary">Save</button>
							</div>
						</form>
					</div>

					{#if pending.length > 0}
						<div class="admin-block">
							<div class="admin-block-head">
								<h2 class="admin-block-title">
									Pending approvals <span class="n">{pending.length}</span>
								</h2>
								<p class="admin-block-sub">
									Approving creates an empty library and lets them sign in, even before their email
									is confirmed.
								</p>
							</div>
							<div class="admin-card tight">
								<div class="attn-list">
									{#each pending as account (account.id)}
										<div class="user-row">
											<div class="user-row-avatar">{initials(account.displayName)}</div>
											<div class="user-row-identity">
												<p class="user-row-name">{account.displayName}</p>
												<p class="user-row-email">
													{account.email} - requested {when(
														account.createdAt
													)}{account.emailVerifiedAt ? '' : ' - email unconfirmed'}
												</p>
											</div>
											<div class="user-row-actions">
												<form method="POST" action="?/reject">
													<input type="hidden" name="userId" value={account.id} />
													<button type="submit" class="btn btn-ghost btn-sm">Decline</button>
												</form>
												<form method="POST" action="?/approve">
													<input type="hidden" name="userId" value={account.id} />
													<button type="submit" class="btn btn-primary btn-sm">Approve</button>
												</form>
											</div>
										</div>
									{/each}
								</div>
							</div>
						</div>
					{/if}

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">
								Accounts <span class="n">{activeUsers.length}</span>
							</h2>
						</div>
						<div class="admin-card">
							<table class="admin-table">
								<thead>
									<tr>
										<th>Person</th>
										<th>Role</th>
										<th>Status</th>
										<th>Joined</th>
										<th></th>
									</tr>
								</thead>
								<tbody>
									{#each activeUsers as account (account.id)}
										<tr>
											<td>
												<div class="cell-user">
													<div class="cell-avatar">{initials(account.displayName)}</div>
													<div>
														<div class="cell-name">
															{account.displayName}
															{#if account.id === data.meId}<span
																	class="pill"
																	style="margin-left:4px;">You</span
																>{/if}
														</div>
														<div class="cell-mail">{account.email}</div>
													</div>
												</div>
											</td>
											<td>
												{#if account.role === 'admin'}
													<span class="role-tag admin">Admin</span>
												{:else}
													<span class="role-tag writer">Writer</span>
												{/if}
											</td>
											<td class="cell-muted">
												{userStatus(account)}{account.publicArchiveEnabled ? ', can publish' : ''}
											</td>
											<td class="cell-muted">{when(account.createdAt)}</td>
											<td class="row-actions">
												<div class="row-actions-inner">
													{#if account.role === 'admin' || account.id === data.meId}
														<span class="cell-muted">-</span>
													{:else}
														{#if !account.emailVerifiedAt}
															<form method="POST" action="?/confirmEmail">
																<input type="hidden" name="userId" value={account.id} />
																<button type="submit" class="btn btn-ghost btn-sm"
																	>Confirm email</button
																>
															</form>
														{/if}
														{#if account.publicArchiveEnabled}
															<form method="POST" action="?/disableArchive">
																<input type="hidden" name="userId" value={account.id} />
																<button type="submit" class="btn btn-ghost btn-sm"
																	>Stop publishing</button
																>
															</form>
														{:else}
															<form method="POST" action="?/enableArchive">
																<input type="hidden" name="userId" value={account.id} />
																<button type="submit" class="btn btn-ghost btn-sm"
																	>Allow publishing</button
																>
															</form>
														{/if}
														{#if account.deletionScheduledAt}
															<form
																method="POST"
																action="?/cancelDeletion"
																onsubmit={(event) => {
																	if (
																		!confirm(
																			`Cancel the scheduled deletion of ${account.email}? The account becomes active again.`
																		)
																	)
																		event.preventDefault();
																}}
															>
																<input type="hidden" name="userId" value={account.id} />
																<button type="submit" class="btn btn-ghost btn-sm"
																	>Cancel deletion</button
																>
															</form>
														{/if}
														{#if account.suspendedAt}
															<form method="POST" action="?/unsuspend">
																<input type="hidden" name="userId" value={account.id} />
																<button type="submit" class="btn btn-ghost btn-sm">Unsuspend</button
																>
															</form>
														{:else}
															<form method="POST" action="?/suspend">
																<input type="hidden" name="userId" value={account.id} />
																<button
																	type="submit"
																	class="btn btn-ghost btn-sm"
																	style="color:var(--danger);">Suspend</button
																>
															</form>
														{/if}
														{#if account.twoFactorEnabled}
															<form
																method="POST"
																action="?/resetTotp"
																onsubmit={(event) => {
																	if (
																		!confirm(
																			`Turn off two-factor authentication for ${account.email}? They will sign in with their password alone until they set it up again.`
																		)
																	)
																		event.preventDefault();
																}}
															>
																<input type="hidden" name="userId" value={account.id} />
																<button type="submit" class="btn btn-ghost btn-sm">Reset 2FA</button
																>
															</form>
														{/if}
														<form
															method="POST"
															action="?/deleteAccount"
															onsubmit={(event) => {
																if (
																	!confirm(
																		`Permanently delete ${account.email} and all their work?`
																	)
																)
																	event.preventDefault();
															}}
														>
															<input type="hidden" name="userId" value={account.id} />
															<button
																type="submit"
																class="btn btn-ghost btn-sm"
																style="color:var(--danger);">Delete</button
															>
														</form>
													{/if}
												</div>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">
								Invite codes <span class="n">{data.inviteCodes.length}</span>
							</h2>
							<p class="admin-block-sub">
								A sign-up with a valid code is approved right away, with no waiting for review.
								Email confirmation still applies.
							</p>
						</div>

						{#if form?.scope === 'invites' && form.message}
							<div
								class="status-banner"
								style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
							>
								<span class="x">{form.message}</span>
							</div>
						{/if}

						<div class="admin-card">
							<form method="POST" action="?/createInvite" class="invite-create">
								<div class="field">
									<label for="invite-label">For</label>
									<input
										id="invite-label"
										class="input"
										type="text"
										name="label"
										placeholder="Who or what the code is for (optional)"
									/>
								</div>
								<div class="field">
									<label for="invite-uses">Uses</label>
									<input
										id="invite-uses"
										class="input"
										type="number"
										name="maxUses"
										value="1"
										min="1"
										max="1000"
									/>
								</div>
								<div class="field">
									<label for="invite-expires">Expires after (days)</label>
									<input
										id="invite-expires"
										class="input"
										type="number"
										name="expiresDays"
										placeholder="Never"
										min="1"
										max="365"
									/>
								</div>
								<button type="submit" class="btn btn-primary">Create code</button>
							</form>

							{#if data.inviteCodes.length > 0}
								<table class="admin-table">
									<thead>
										<tr>
											<th>Code</th>
											<th>For</th>
											<th>Uses</th>
											<th>Status</th>
											<th></th>
										</tr>
									</thead>
									<tbody>
										{#each data.inviteCodes as code (code.id)}
											<tr>
												<td><span class="invite-code">{code.code}</span></td>
												<td class="cell-muted">{code.label ?? '-'}</td>
												<td class="cell-muted">{code.usedCount}/{code.maxUses}</td>
												<td class="cell-muted">
													{inviteStatus(code)}{code.expiresAt && inviteStatus(code) === 'Active'
														? `, expires ${when(code.expiresAt)}`
														: ''}
												</td>
												<td class="row-actions">
													<div class="row-actions-inner">
														<button
															type="button"
															class="btn btn-ghost btn-sm"
															onclick={() => copyInviteLink(code)}
														>
															{copiedInviteId === code.id ? 'Copied' : 'Copy link'}
														</button>
														<form method="POST" action="?/deleteInvite">
															<input type="hidden" name="inviteId" value={code.id} />
															<button
																type="submit"
																class="btn btn-ghost btn-sm"
																style="color:var(--danger);">Delete</button
															>
														</form>
													</div>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							{/if}
						</div>
					</div>
				</section>

				<!-- ========== AI (stub) ========== -->
				<section class="admin-section" class:active={active === 'ai'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Instance</p>
						<h1 class="admin-title">AI</h1>
						<p class="admin-lede">Model roles and shared endpoints will be configured here.</p>
					</div>
					<div class="admin-card">
						<p class="admin-block-sub" style="margin:0;">
							Coming in a later release. Codex does not call any AI service yet.
						</p>
					</div>
				</section>

				<!-- ========== USAGE & STORAGE ========== -->
				<section class="admin-section" class:active={active === 'usage'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Data</p>
						<h1 class="admin-title">Usage &amp; storage</h1>
						<p class="admin-lede">
							Where uploaded images and stored export files are kept.
							{#if data.assetStorage.source === 'environment'}
								Currently taking values from the environment; saving here overrides them.
							{:else if data.assetStorage.source === 'none'}
								Not configured yet; until a bucket is set below, image uploads are off.
							{/if}
						</p>
					</div>

					{#if form?.scope === 'storage' && form.message}
						<div
							class="status-banner"
							style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
						>
							<span class="x">{form.message}</span>
						</div>
					{:else if form?.scope === 'storage' && form.saved}
						<div class="status-banner ok">
							<span class="dot"></span><span class="v">Saved.</span>
						</div>
					{:else if form?.scope === 'storage' && form.tested}
						<div class="status-banner ok">
							<span class="dot"></span><span class="v">The bucket is reachable and writable.</span>
						</div>
					{:else if form?.scope === 'storage' && form.migrating}
						<div class="status-banner ok">
							<span class="dot"></span><span class="v"
								>Copy started. The worker copies every stored file; check back here for the result.</span
							>
						</div>
					{/if}

					{#if data.assetMigrationPending}
						<div
							class="status-banner"
							style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
						>
							<span class="x">
								Files uploaded before the storage change are still in the old location. Copy them to
								the new storage, or dismiss this if you moved them yourself.
							</span>
							<span class="when" style="display:flex;gap:8px;">
								<form method="POST" action="?/migrateAssets">
									<button type="submit" class="btn btn-primary btn-sm">Copy files</button>
								</form>
								<form method="POST" action="?/dismissMigration">
									<button type="submit" class="btn btn-ghost btn-sm">Dismiss</button>
								</form>
							</span>
						</div>
					{/if}

					{#if data.assetMigration}
						<p class="admin-block-sub">
							Last copy finished {when(data.assetMigration.finishedAt)}: {data.assetMigration
								.copied} copied, {data.assetMigration.failed} failed{data.assetMigration.failed > 0
								? '. Failures are listed in the worker log; run the copy again to retry.'
								: '.'}
						</p>
					{/if}

					{#if !data.secretsAvailable}
						<div
							class="status-banner"
							style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
						>
							<span class="x">
								Set APP_SECRET on the server to store a secret key here. Without it you can still
								seed asset storage from environment variables.
							</span>
						</div>
					{/if}

					<div class="admin-block">
						<div class="admin-block-head">
							<div>
								<h2 class="admin-block-title">Asset storage</h2>
								<p class="admin-block-sub">
									Any S3-compatible bucket works: S3, Backblaze B2, MinIO, R2. Use a different
									bucket than the one holding backups, so a database restore keeps every image link
									valid.
								</p>
							</div>
						</div>
						<div class="admin-card">
							<form method="POST" action="?/saveAssets">
								{@render s3Fields('asset', data.assetStorage)}
								<div class="settings-actions">
									<button type="submit" formaction="?/testAssets" class="btn btn-ghost">
										Test connection
									</button>
									<button type="submit" class="btn btn-primary">Save</button>
								</div>
							</form>
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-card">
							<p class="admin-block-sub" style="margin:0;">
								Per-writer usage and a storage breakdown will come in a later release.
							</p>
						</div>
					</div>
				</section>

				<!-- ========== PUBLISHED ========== -->
				<section class="admin-section" class:active={active === 'published'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Data</p>
						<h1 class="admin-title">Published editions</h1>
						<p class="admin-lede">
							Everything writers have made public. Take an edition down to remove it from the public
							pages.
						</p>
					</div>

					{#if form?.scope === 'published' && form.message}
						<div
							class="status-banner"
							style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
						>
							<span class="x">{form.message}</span>
						</div>
					{/if}

					<div class="admin-block">
						{#if liveEditions.length === 0}
							<div class="admin-card">
								<p class="admin-block-sub" style="margin:0;">Nothing is published right now.</p>
							</div>
						{:else}
							<div class="admin-card tight">
								<div class="attn-list">
									{#each liveEditions as edition (edition.id)}
										<div class="list-row">
											<div class="list-main">
												<div class="list-title">
													@{edition.handle}/{edition.title}
													<span class="pill">{edition.isCurrent ? 'current' : 'superseded'}</span>
													{#if edition.isAdult}<span class="pill">adult</span>{/if}
												</div>
												<div class="list-sub">published {when(edition.publishedAt)}</div>
											</div>
											<div class="list-actions">
												<form method="POST" action="?/takedown">
													<input type="hidden" name="publicationId" value={edition.id} />
													<button
														type="submit"
														class="btn btn-ghost btn-sm"
														style="color:var(--danger);">Take down</button
													>
												</form>
											</div>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				</section>

				<!-- ========== BACKUPS ========== -->
				<section class="admin-section" class:active={active === 'backups'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Data</p>
						<h1 class="admin-title">Backups</h1>
						<p class="admin-lede">
							Off-site database snapshots taken by the worker.
							{#if data.backupStorage.source === 'environment'}
								Currently taking values from the environment; saving here overrides them.
							{:else if data.backupStorage.source === 'none'}
								Not configured yet; until a bucket is set below, no snapshots are taken.
							{/if}
						</p>
					</div>

					{#if form?.scope === 'backups' && form.message}
						<div
							class="status-banner"
							style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
						>
							<span class="x">{form.message}</span>
						</div>
					{:else if form?.scope === 'backups' && form.saved}
						<div class="status-banner ok">
							<span class="dot"></span><span class="v">Saved.</span>
						</div>
					{:else if form?.scope === 'backups' && form.tested}
						<div class="status-banner ok">
							<span class="dot"></span><span class="v">The bucket is reachable and writable.</span>
						</div>
					{:else if form?.scope === 'backups' && form.done}
						<div class="status-banner ok">
							<span class="dot"></span><span class="v"
								>Backup queued. Refresh to see the result.</span
							>
						</div>
					{/if}

					{#if data.backupsConfigured}
						<div class="admin-block">
							<div class="status-banner ok">
								<span class="dot"></span>
								<span>
									<span class="v">Backups are on</span>
									{#if lastBackup}<span class="x"
											>- last run {lastBackup.status} on {when(lastBackup.startedAt)}</span
										>{/if}
								</span>
								<span class="when">
									<form method="POST" action="?/runBackup">
										<button type="submit" class="btn btn-primary btn-sm">Back up now</button>
									</form>
								</span>
							</div>
						</div>
					{/if}

					{#if !data.secretsAvailable}
						<div
							class="status-banner"
							style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
						>
							<span class="x">
								Set APP_SECRET on the server to store a secret key here. Without it you can still
								seed backups from environment variables.
							</span>
						</div>
					{/if}

					<div class="admin-block">
						<div class="admin-block-head">
							<div>
								<h2 class="admin-block-title">Storage</h2>
								<p class="admin-block-sub">
									Any S3-compatible bucket works: S3, Backblaze B2, MinIO, R2. Use a different
									bucket than the one holding uploaded images.
								</p>
							</div>
						</div>
						<div class="admin-card">
							<form method="POST" action="?/saveBackups">
								{@render s3Fields('backup', data.backupStorage)}
								<div class="field-grid">
									<div class="field">
										<label for="backup-keep-hours">Keep every dump for (hours)</label>
										<input
											id="backup-keep-hours"
											class="input"
											type="number"
											name="keepRecentHours"
											min="1"
											value={data.backupStorage.keepRecentHours}
										/>
									</div>
									<div class="field">
										<label for="backup-keep-days">Keep one dump per day for (days)</label>
										<input
											id="backup-keep-days"
											class="input"
											type="number"
											name="keepDays"
											min="1"
											value={data.backupStorage.keepDays}
										/>
									</div>
								</div>
								<div class="settings-actions">
									<button type="submit" formaction="?/testBackups" class="btn btn-ghost">
										Test connection
									</button>
									<button type="submit" class="btn btn-primary">Save</button>
								</div>
							</form>
						</div>
					</div>

					{#if data.backupRuns.length > 0}
						<div class="admin-block">
							<div class="admin-block-head">
								<h2 class="admin-block-title">Recent runs</h2>
							</div>
							<div class="admin-card tight">
								<div class="attn-list">
									{#each data.backupRuns as run (run.id)}
										<div class="list-row">
											<div class="list-main">
												<div class="list-title">
													{run.status}
													<span class="pill">{run.trigger}</span>
												</div>
												<div class="list-sub">
													{run.sizeBytes
														? `${(run.sizeBytes / 1024).toFixed(0)} KB`
														: 'no size'}{run.error ? ` - ${run.error}` : ''}
												</div>
											</div>
											<div class="list-sub">{when(run.startedAt)}</div>
										</div>
									{/each}
								</div>
							</div>
						</div>
					{/if}
				</section>

				<!-- ========== AUDIT (stub) ========== -->
				<section class="admin-section" class:active={active === 'audit'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Data</p>
						<h1 class="admin-title">Audit log</h1>
						<p class="admin-lede">
							Sign-ins, approvals, and configuration changes will be recorded here.
						</p>
					</div>
					<div class="admin-card">
						<p class="admin-block-sub" style="margin:0;">Coming in a later release.</p>
					</div>
				</section>

				<!-- ========== EMAIL RELAY (SMTP) ========== -->
				<section class="admin-section" class:active={active === 'instance'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Configuration</p>
						<h1 class="admin-title">Email relay</h1>
						<p class="admin-lede">
							Used to send verification, password-reset, and notification emails.
							{#if data.smtp.source === 'environment'}
								Currently taking values from the environment; saving here overrides them.
							{:else if data.smtp.source === 'none'}
								Not configured yet; until it is, emails are written to the worker log instead of
								sent.
							{/if}
						</p>
					</div>

					{#if !data.secretsAvailable}
						<div
							class="status-banner"
							style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
						>
							<span class="x">
								Set APP_SECRET on the server to store a password here. Without it you can still seed
								SMTP from environment variables.
							</span>
						</div>
					{/if}

					<div class="admin-block">
						<div class="admin-card">
							<form method="POST" action="?/saveSmtp">
								{#if form?.scope === 'smtp' && form.message}
									<div
										class="status-banner"
										style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
									>
										<span class="x">{form.message}</span>
									</div>
								{:else if form?.scope === 'smtp' && form.saved}
									<div class="status-banner ok">
										<span class="dot"></span><span class="v">Saved.</span>
									</div>
								{:else if form?.scope === 'smtp' && form.tested}
									<div class="status-banner ok">
										<span class="dot"></span><span class="v">Test email sent.</span>
									</div>
								{/if}

								<div class="field-grid">
									<div class="field">
										<label for="smtp-host">Host</label>
										<input
											id="smtp-host"
											class="input"
											type="text"
											name="host"
											value={data.smtp.host}
											placeholder="smtp.example.com"
										/>
									</div>
									<div class="field">
										<label for="smtp-port">Port</label>
										<input
											id="smtp-port"
											class="input"
											type="number"
											name="port"
											value={data.smtp.port}
										/>
									</div>
								</div>

								<div class="toggle-row" style="margin-bottom:var(--space-4);">
									<label class="toggle">
										<input type="checkbox" name="secure" checked={data.smtp.secure} />
										<span class="toggle-track"></span>
									</label>
									<div style="flex:1;">
										<div class="t-title">Use TLS on connect</div>
										<div class="t-sub">Turn on for port 465. Leave off for STARTTLS on 587.</div>
									</div>
								</div>

								<div class="field">
									<label for="smtp-user">Username</label>
									<input
										id="smtp-user"
										class="input"
										type="text"
										name="user"
										value={data.smtp.user}
										autocomplete="off"
									/>
								</div>
								<div class="field">
									<label for="smtp-password">Password</label>
									<input
										id="smtp-password"
										class="input"
										type="password"
										name="password"
										autocomplete="off"
										placeholder={data.smtp.hasPassword
											? 'Leave blank to keep the current password'
											: ''}
									/>
								</div>
								<div class="field" style="margin-bottom:0;">
									<label for="smtp-from">From address</label>
									<input
										id="smtp-from"
										class="input"
										type="text"
										name="from"
										value={data.smtp.from}
										placeholder="Codex <no-reply@example.com>"
									/>
								</div>

								<div class="settings-actions">
									<button type="submit" formaction="?/testEmail" class="btn btn-ghost"
										>Send test email</button
									>
									<button type="submit" class="btn btn-primary">Save</button>
								</div>
							</form>
						</div>
					</div>
				</section>
			</div>
		</main>
	</div>
</div>
