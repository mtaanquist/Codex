<script lang="ts">
	import { resolve } from '$app/paths';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import NotificationBell from '$lib/components/NotificationBell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Section =
		| 'overview'
		| 'users'
		| 'ai'
		| 'usage'
		| 'published'
		| 'backups'
		| 'audit'
		| 'instance';

	// After an action, jump to the section that owns the result so the admin
	// sees the message where it belongs.
	function sectionFor(scope: string | undefined): Section | null {
		switch (scope) {
			case 'accounts':
			case 'invites':
				return 'users';
			case 'published':
				return 'published';
			case 'backups':
				return 'backups';
			case 'smtp':
				return 'instance';
			default:
				return null;
		}
	}

	// Defaults to the overview; the effect below moves to the section that owns
	// an action result (it also runs once on mount, so a server-side redirect
	// into, say, the accounts list lands there).
	let active = $state<Section>('overview');
	$effect(() => {
		const s = sectionFor(form?.scope);
		if (s) active = s;
	});

	function go(section: Section) {
		active = section;
	}

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
				sub: 'Approving creates their library and lets them sign in.',
				goto: 'users'
			});
		}
		if (!data.backupsConfigured) {
			list.push({
				tone: 'warn',
				title: 'Off-site backups are not configured',
				sub: 'Set the BACKUP_S3_* variables and restart so the worker can take hourly dumps.',
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

<div class="page-shell">
	<header class="topbar">
		<a class="brand" href={resolve('/')}>
			<span class="brand-name">Codex</span>
		</a>
		<span class="divider"></span>
		<a class="back-link" href={resolve('/')}>
			<svg
				viewBox="0 0 12 12"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"><polyline points="7.5 2.5 3 6 7.5 9.5" /></svg
			>
			Library
		</a>
		<span class="spacer"></span>
		<NotificationBell />
		<UserMenu />
	</header>

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

					{#if pending.length > 0}
						<div class="admin-block">
							<div class="admin-block-head">
								<h2 class="admin-block-title">
									Pending approvals <span class="n">{pending.length}</span>
								</h2>
								<p class="admin-block-sub">
									Approving creates an empty library and lets them sign in.
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

				<!-- ========== USAGE (stub) ========== -->
				<section class="admin-section" class:active={active === 'usage'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Data</p>
						<h1 class="admin-title">Usage &amp; storage</h1>
						<p class="admin-lede">Per-writer usage and a storage breakdown will live here.</p>
					</div>
					<div class="admin-card">
						<p class="admin-block-sub" style="margin:0;">Coming in a later release.</p>
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
						<p class="admin-lede">Off-site database snapshots taken by the worker.</p>
					</div>

					{#if form?.scope === 'backups' && form.message}
						<div
							class="status-banner"
							style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
						>
							<span class="x">{form.message}</span>
						</div>
					{/if}

					<div class="admin-block">
						{#if !data.backupsConfigured}
							<div class="admin-card">
								<p class="admin-block-sub" style="margin:0;">
									Off-site backups are not configured. Set the BACKUP_S3_* variables (see
									.env.example) and restart; the worker then uploads an hourly database dump.
								</p>
							</div>
						{:else}
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
							{#if form?.scope === 'backups' && form.done}
								<p class="admin-block-sub">Backup queued. Refresh to see the result.</p>
							{/if}
						{/if}
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
