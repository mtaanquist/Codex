<script lang="ts">
	import { page } from '$app/state';
	import type { PageData, ActionData } from './$types';
	import { formatDate, formatDateTime, relativeShort } from '#lib/format';
	import { now } from '#lib/now.svelte';
	import AdminUserActions from './AdminUserActions.svelte';
	import { authorInitials } from '#lib/review-ui';

	let { data, form }: { data: PageData; form: ActionData } = $props();

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
</script>

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
				Approving creates an empty library and lets them sign in, even before their email is
				confirmed.
			</p>
		</div>
		<div class="admin-card tight">
			<div class="attn-list">
				{#each pending as account (account.id)}
					<div class="user-row">
						<div class="user-row-avatar">{authorInitials(account.displayName)}</div>
						<div class="user-row-identity">
							<p class="user-row-name">{account.displayName}</p>
							<p class="user-row-email">
								{account.email} - requested {formatDate(
									account.createdAt,
									page.data.timeZone
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
	<div class="admin-card accounts-card">
		<table class="admin-table accounts-table">
			<thead>
				<tr>
					<th>Person</th>
					<th>Status</th>
					<th>Joined</th>
					<th>Last active</th>
					<th>Invites</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each activeUsers as account (account.id)}
					<tr>
						<td>
							<div class="cell-user">
								<div class="cell-avatar">{authorInitials(account.displayName)}</div>
								<div>
									<div class="cell-name">
										{account.displayName}
										{#if account.role === 'admin'}<span class="role-tag admin">Admin</span>{/if}
										{#if account.id === data.meId}<span class="pill">You</span>{/if}
									</div>
									<div class="cell-mail">{account.email}</div>
								</div>
							</div>
						</td>
						<td class="cell-muted" data-label="Status">
							{userStatus(account)}{account.publicArchiveEnabled ? ', can publish' : ''}
						</td>
						<td class="cell-muted cell-nowrap" data-label="Joined"
							>{formatDate(account.createdAt, page.data.timeZone)}</td
						>
						<td class="cell-muted cell-nowrap" data-label="Last active">
							{#if account.lastActiveAt}
								<time
									datetime={new Date(account.lastActiveAt).toISOString()}
									title={formatDateTime(account.lastActiveAt, page.data.timeZone)}
									>{relativeShort(account.lastActiveAt, page.data.timeZone, now())}</time
								>
							{:else}
								Never
							{/if}
						</td>
						<td data-label="Invites">
							<form method="POST" action="?/setInviteAllowance" class="allowance-form">
								<input type="hidden" name="userId" value={account.id} />
								<input
									class="input allowance-input"
									type="number"
									name="allowance"
									min="0"
									max="99"
									value={account.inviteAllowance}
									aria-label="Invite allowance for {account.email}"
								/>
								<button type="submit" class="btn btn-ghost btn-sm">Set</button>
							</form>
						</td>
						<td class="cell-actions">
							<AdminUserActions {account} isMe={account.id === data.meId} />
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
			A sign-up with a valid code is approved right away, with no waiting for review. Email
			confirmation still applies.
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
									? `, expires ${formatDate(code.expiresAt, page.data.timeZone)}`
									: ''}
							</td>
							<td class="cell-actions">
								<div class="cell-actions-inner">
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
											style="color:var(--danger-ink);">Delete</button
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

<style>
	/* Below about 640px the accounts table cannot fit its columns, so each
	   account becomes a stacked block with a label beside each value. */
	.accounts-card {
		container-type: inline-size;
	}
	@container (max-width: 640px) {
		.accounts-table thead {
			display: none;
		}
		.accounts-table,
		.accounts-table tbody,
		.accounts-table tr,
		.accounts-table td {
			display: block;
		}
		.accounts-table tr {
			padding: 10px 0;
			border-bottom: 1px solid var(--border);
		}
		.accounts-table tr:last-child {
			border-bottom: 0;
		}
		.accounts-table td {
			padding: 4px 0;
			border-bottom: 0;
		}
		.accounts-table td[data-label] {
			display: flex;
			align-items: center;
			gap: 12px;
		}
		.accounts-table td[data-label]::before {
			content: attr(data-label);
			flex: none;
			width: 7rem;
			font-size: 12px;
			color: var(--text-faint);
		}
		.accounts-table .cell-actions {
			text-align: left;
			padding-top: 8px;
		}
		/* The button now sits on the left, so its menu opens rightwards. */
		.accounts-table .cell-actions :global(.popover) {
			left: 0;
			right: auto;
		}
	}
	/* The per-row invite allowance: a number and a Set. */
	.allowance-form {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.allowance-input {
		width: 3.6rem;
		padding: 3px 6px;
		font-size: 12.5px;
	}
</style>
