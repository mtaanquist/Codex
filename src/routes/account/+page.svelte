<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function seen(date: Date): string {
		return new Date(date).toLocaleString(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		});
	}
</script>

<svelte:head>
	<title>Account - Codex</title>
</svelte:head>

<main>
	<p class="crumbs"><a href={resolve('/')}>Library</a> / Account</p>
	<h1>Account</h1>

	<section>
		<h2>Display name</h2>
		<form method="POST" action="?/updateName">
			<label>
				Display name
				<input
					type="text"
					name="displayName"
					value={data.displayName}
					required
					autocomplete="name"
				/>
			</label>
			<button type="submit">Save</button>
			{#if form?.scope === 'name' && form.message}
				<span class="error" role="alert">{form.message}</span>
			{:else if form?.scope === 'name' && form.saved}
				<span class="ok" role="status">Saved.</span>
			{/if}
		</form>
	</section>

	<section>
		<h2>Email</h2>
		<p>Your email address is <strong>{data.email}</strong>.</p>
	</section>

	<section>
		<h2>Password</h2>
		<form method="POST" action="?/changePassword">
			<label>
				Current password
				<input type="password" name="currentPassword" required autocomplete="current-password" />
			</label>
			<label>
				New password
				<input
					type="password"
					name="newPassword"
					required
					minlength="8"
					autocomplete="new-password"
				/>
			</label>
			<button type="submit">Change password</button>
			{#if form?.scope === 'password' && form.message}
				<span class="error" role="alert">{form.message}</span>
			{:else if form?.scope === 'password' && form.saved}
				<span class="ok" role="status">Password changed. Other devices have been signed out.</span>
			{/if}
		</form>
	</section>

	<section>
		<h2>Active sessions</h2>
		<p>These are the devices signed in to your account.</p>
		<ul class="sessions">
			{#each data.sessions as session (session.id)}
				<li>
					<div>
						<span>{session.userAgent ?? 'Unknown device'}</span>
						<span class="meta">Last active {seen(session.lastSeenAt)}</span>
					</div>
					{#if session.current}
						<span class="current">This device</span>
					{:else}
						<form method="POST" action="?/revokeSession">
							<input type="hidden" name="sessionId" value={session.id} />
							<button type="submit">Sign out</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
		{#if data.sessions.length > 1}
			<form method="POST" action="?/revokeOthers">
				<button type="submit">Sign out everywhere else</button>
			</form>
		{/if}
		{#if form?.scope === 'sessions' && form.saved}
			<span class="ok" role="status">Done.</span>
		{/if}
	</section>

	<section>
		<h2>Your data</h2>
		<p>
			Download everything you have written - every universe, story, scene, and worldbuilding entry,
			with your images - as a folder of markdown files.
		</p>
		<p><a href={resolve('/account/export')} data-sveltekit-reload>Download everything</a></p>
	</section>

	<section class="danger">
		<h2>Delete account</h2>
		<p>
			This deletes your account and everything you have written. Your public pages come down
			straight away, and after {data.graceDays} days everything is removed for good. We email you a link
			to cancel if you change your mind before then. Download your work above first if you want a copy.
		</p>
		<form method="POST" action="?/deleteAccount">
			{#if form?.scope === 'delete' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			<label>
				Confirm your password to continue
				<input type="password" name="password" required autocomplete="current-password" />
			</label>
			<button type="submit" class="danger-btn">Delete my account</button>
		</form>
	</section>
</main>

<style>
	main {
		max-width: 40rem;
		margin: 4vh auto 0;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}
	.crumbs {
		font-size: 0.875rem;
	}
	section {
		margin-bottom: 2rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		align-items: flex-start;
		max-width: 22rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
	}
	.sessions {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: 30rem;
	}
	.sessions li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid #ddd;
		border-radius: 0.5rem;
	}
	.sessions li div {
		display: flex;
		flex-direction: column;
	}
	.meta {
		font-size: 0.8125rem;
		color: #666;
	}
	.current {
		font-size: 0.8125rem;
		color: #444;
	}
	.error {
		color: #b00020;
	}
	.ok {
		color: #1a7f37;
	}
	.danger {
		border-top: 1px solid #f0c0c0;
		padding-top: 1.5rem;
	}
	.danger h2 {
		color: #b00020;
	}
	.danger-btn {
		color: #b00020;
	}
</style>
