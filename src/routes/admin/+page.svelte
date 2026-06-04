<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function when(date: Date | string): string {
		return new Date(date).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function status(u: PageData['users'][number]): string {
		if (u.suspendedAt) return 'suspended';
		if (!u.approvedAt) return u.emailVerifiedAt ? 'pending approval' : 'pending, email unconfirmed';
		return 'active';
	}
</script>

<svelte:head>
	<title>Site admin - Codex</title>
</svelte:head>

<main>
	<p class="crumbs"><a href={resolve('/')}>Library</a> / Site admin</p>
	<h1>Site admin</h1>

	<section>
		<h2>Accounts</h2>
		{#if form?.scope === 'accounts' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<ul class="rows">
			{#each data.users as account (account.id)}
				<li>
					<div class="who">
						<strong>{account.displayName}</strong>
						{#if account.role === 'admin'}<span class="tag">admin</span>{/if}
						<span class="email">{account.email}</span>
						<span class="meta">
							{status(account)} - joined {when(account.createdAt)}
							{#if account.publicArchiveEnabled}
								- can publish{/if}
						</span>
					</div>
					{#if account.role !== 'admin'}
						<div class="actions">
							{#if !account.approvedAt}
								<form method="POST" action="?/approve">
									<input type="hidden" name="userId" value={account.id} />
									<button type="submit">Approve</button>
								</form>
								<form method="POST" action="?/reject">
									<input type="hidden" name="userId" value={account.id} />
									<button type="submit" class="danger">Reject</button>
								</form>
							{:else}
								{#if account.publicArchiveEnabled}
									<form method="POST" action="?/disableArchive">
										<input type="hidden" name="userId" value={account.id} />
										<button type="submit">Disable publishing</button>
									</form>
								{:else}
									<form method="POST" action="?/enableArchive">
										<input type="hidden" name="userId" value={account.id} />
										<button type="submit">Enable publishing</button>
									</form>
								{/if}
								{#if account.suspendedAt}
									<form method="POST" action="?/unsuspend">
										<input type="hidden" name="userId" value={account.id} />
										<button type="submit">Unsuspend</button>
									</form>
								{:else}
									<form method="POST" action="?/suspend">
										<input type="hidden" name="userId" value={account.id} />
										<button type="submit" class="danger">Suspend</button>
									</form>
								{/if}
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h2>Published editions</h2>
		{#if form?.scope === 'published' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if data.published.length === 0}
			<p>Nothing has been published yet.</p>
		{:else}
			<ul class="rows">
				{#each data.published as edition (edition.id)}
					<li>
						<div class="who">
							<strong class:struck={edition.removedAt !== null}>
								@{edition.handle}/{edition.title}
							</strong>
							<span class="meta">
								{edition.removedAt
									? 'taken down'
									: edition.isCurrent
										? 'current'
										: 'superseded'}{edition.isAdult ? ', adult' : ''} - {when(edition.publishedAt)}
							</span>
						</div>
						{#if !edition.removedAt}
							<div class="actions">
								<form method="POST" action="?/takedown">
									<input type="hidden" name="publicationId" value={edition.id} />
									<button type="submit" class="danger">Take down</button>
								</form>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<h2>Email relay (SMTP)</h2>
		<p>
			Used to send verification, password-reset, and notification emails.
			{#if data.smtp.source === 'environment'}
				Currently taking values from the environment; saving here overrides them.
			{:else if data.smtp.source === 'none'}
				Not configured yet; until it is, emails are written to the worker log instead of sent.
			{/if}
		</p>
		{#if !data.secretsAvailable}
			<p class="error">
				Set APP_SECRET on the server to store a password here. Without it you can still seed SMTP
				from environment variables.
			</p>
		{/if}
		<form method="POST" action="?/saveSmtp" class="stack">
			{#if form?.scope === 'smtp' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{:else if form?.scope === 'smtp' && form.saved}
				<p class="ok" role="status">Saved.</p>
			{:else if form?.scope === 'smtp' && form.tested}
				<p class="ok" role="status">Test email sent.</p>
			{/if}
			<label>
				Host
				<input type="text" name="host" value={data.smtp.host} placeholder="smtp.example.com" />
			</label>
			<label>
				Port
				<input type="number" name="port" value={data.smtp.port} />
			</label>
			<label class="row">
				<input type="checkbox" name="secure" checked={data.smtp.secure} />
				Use TLS on connect (port 465)
			</label>
			<label>
				Username
				<input type="text" name="user" value={data.smtp.user} autocomplete="off" />
			</label>
			<label>
				Password
				<input
					type="password"
					name="password"
					autocomplete="off"
					placeholder={data.smtp.hasPassword ? 'Leave blank to keep the current password' : ''}
				/>
			</label>
			<label>
				From address
				<input
					type="text"
					name="from"
					value={data.smtp.from}
					placeholder="Codex <no-reply@example.com>"
				/>
			</label>
			<div class="actions">
				<button type="submit">Save</button>
				<button type="submit" formaction="?/testEmail">Send test email</button>
			</div>
		</form>
	</section>

	<section>
		<h2>Backups</h2>
		{#if form?.scope === 'backups' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if !data.backupsConfigured}
			<p>
				Off-site backups are not configured. Set the BACKUP_S3_* variables (see .env.example) and
				restart; the worker then uploads an hourly database dump.
			</p>
		{:else}
			<form method="POST" action="?/runBackup">
				<button type="submit">Back up now</button>
				{#if form?.scope === 'backups' && form.done}
					<span class="ok" role="status">Backup queued. Refresh to see the result.</span>
				{/if}
			</form>
		{/if}
		{#if data.backupRuns.length > 0}
			<ul class="runs">
				{#each data.backupRuns as run (run.id)}
					<li>
						<span class:struck={run.status === 'failed'}>{run.status}</span>
						<span class="meta">
							{run.trigger}{run.sizeBytes ? `, ${(run.sizeBytes / 1024).toFixed(0)} KB` : ''}
							{run.error ? ` - ${run.error}` : ''}
						</span>
						<span class="at">{when(run.startedAt)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>

<style>
	main {
		max-width: 48rem;
		margin: 4vh auto 0;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}
	.crumbs {
		font-size: 0.875rem;
	}
	section {
		margin-bottom: 2.5rem;
	}
	.rows {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.6rem 0.85rem;
		border: 1px solid #ddd;
		border-radius: 0.5rem;
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.tag {
		font-size: 0.75rem;
		color: #444;
	}
	.email {
		color: #444;
		font-size: 0.9rem;
	}
	.meta {
		font-size: 0.8125rem;
		color: #666;
	}
	.struck {
		text-decoration: line-through;
		color: #b00020;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		max-width: 26rem;
	}
	.stack label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.stack label.row {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	.danger {
		color: #b00020;
	}
	.runs {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-top: 0.5rem;
	}
	.runs li {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
		font-size: 0.9rem;
	}
	.at {
		margin-left: auto;
		color: #999;
		font-size: 0.8rem;
	}
	.error {
		color: #b00020;
	}
	.ok {
		color: #1a7f37;
		margin-left: 0.5rem;
	}
</style>
