<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function signedUp(date: Date): string {
		return new Date(date).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>Pending accounts - Codex</title>
</svelte:head>

<main>
	<p class="crumbs"><a href={resolve('/')}>Library</a> / Pending accounts</p>
	<h1>Pending accounts</h1>

	{#if form?.message}
		<p class="error" role="alert">{form.message}</p>
	{/if}

	{#if data.pending.length === 0}
		<p>No accounts are waiting for review.</p>
	{:else}
		<p>Approve an account to let it sign in. Reject one to remove it.</p>
		<ul class="accounts">
			{#each data.pending as account (account.id)}
				<li>
					<div class="who">
						<strong>{account.displayName}</strong>
						<span class="email">{account.email}</span>
						<span class="meta">
							Signed up {signedUp(account.createdAt)}
							{#if account.emailVerifiedAt}
								- email confirmed
							{:else}
								- email not yet confirmed
							{/if}
						</span>
					</div>
					<div class="actions">
						<form method="POST" action="?/approve">
							<input type="hidden" name="userId" value={account.id} />
							<button type="submit">Approve</button>
						</form>
						<form method="POST" action="?/reject">
							<input type="hidden" name="userId" value={account.id} />
							<button type="submit" class="reject">Reject</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	main {
		max-width: 44rem;
		margin: 4vh auto 0;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}
	.crumbs {
		font-size: 0.875rem;
	}
	.accounts {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.accounts li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border: 1px solid #ddd;
		border-radius: 0.5rem;
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.email {
		color: #444;
	}
	.meta {
		font-size: 0.8125rem;
		color: #666;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	.reject {
		color: #b00020;
	}
	.error {
		color: #b00020;
	}
</style>
