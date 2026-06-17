<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { formatDate } from '$lib/format';
	import { authorInitials } from '$lib/review-ui';

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
								{account.email} - requested {formatDate(account.createdAt)}{account.emailVerifiedAt
									? ''
									: ' - email unconfirmed'}
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
								<div class="cell-avatar">{authorInitials(account.displayName)}</div>
								<div>
									<div class="cell-name">
										{account.displayName}
										{#if account.id === data.meId}<span class="pill" style="margin-left:4px;"
												>You</span
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
						<td class="cell-muted">{formatDate(account.createdAt)}</td>
						<td class="row-actions">
							<div class="row-actions-inner">
								{#if account.publicArchiveEnabled}
									<form method="POST" action="?/disableArchive">
										<input type="hidden" name="userId" value={account.id} />
										<button type="submit" class="btn btn-ghost btn-sm">Stop publishing</button>
									</form>
								{:else}
									<form method="POST" action="?/enableArchive">
										<input type="hidden" name="userId" value={account.id} />
										<button type="submit" class="btn btn-ghost btn-sm">Allow publishing</button>
									</form>
								{/if}
								{#if account.role !== 'admin' && account.id !== data.meId}
									{#if !account.emailVerifiedAt}
										<form method="POST" action="?/confirmEmail">
											<input type="hidden" name="userId" value={account.id} />
											<button type="submit" class="btn btn-ghost btn-sm">Confirm email</button>
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
											<button type="submit" class="btn btn-ghost btn-sm">Cancel deletion</button>
										</form>
									{/if}
									{#if account.suspendedAt}
										<form method="POST" action="?/unsuspend">
											<input type="hidden" name="userId" value={account.id} />
											<button type="submit" class="btn btn-ghost btn-sm">Unsuspend</button>
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
											<button type="submit" class="btn btn-ghost btn-sm">Reset 2FA</button>
										</form>
									{/if}
									<form
										method="POST"
										action="?/deleteAccount"
										onsubmit={(event) => {
											if (!confirm(`Permanently delete ${account.email} and all their work?`))
												event.preventDefault();
										}}
									>
										<input type="hidden" name="userId" value={account.id} />
										<button type="submit" class="btn btn-ghost btn-sm" style="color:var(--danger);"
											>Delete</button
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
									? `, expires ${formatDate(code.expiresAt)}`
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
										<button type="submit" class="btn btn-ghost btn-sm" style="color:var(--danger);"
											>Delete</button
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
