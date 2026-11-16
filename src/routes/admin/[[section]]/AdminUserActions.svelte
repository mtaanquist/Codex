<script lang="ts">
	import { confirmSubmit } from '#lib/confirm.svelte';
	import { dismiss } from '#lib/dismiss';
	import { menu } from '#lib/menu';
	import Icon from '#lib/components/Icon.svelte';
	import type { PageData } from './$types';

	// One "Actions" button per account row, so every row keeps the same width
	// and the control sits in the same place whatever applies to the account.
	let { account, isMe }: { account: PageData['users'][number]; isMe: boolean } = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();

	function close() {
		open = false;
	}

	// Admins and your own account only get the publishing toggle.
	const manageable = $derived(account.role !== 'admin' && !isMe);
</script>

<span class="menu-host" use:dismiss={{ enabled: open, close, refocus: () => trigger?.focus() }}>
	<button
		class="btn btn-ghost btn-sm"
		type="button"
		bind:this={trigger}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Actions for {account.email}"
		onclick={() => (open = !open)}
	>
		Actions
		<span class="actions-caret"><Icon name="caret" /></span>
	</button>
	{#if open}
		<div class="popover" role="menu" use:menu={{ close, refocus: () => trigger?.focus() }}>
			{#if account.publicArchiveEnabled}
				<form method="POST" action="?/disableArchive">
					<input type="hidden" name="userId" value={account.id} />
					<button class="menu-item" type="submit" role="menuitem">Stop publishing</button>
				</form>
			{:else}
				<form method="POST" action="?/enableArchive">
					<input type="hidden" name="userId" value={account.id} />
					<button class="menu-item" type="submit" role="menuitem">Allow publishing</button>
				</form>
			{/if}
			{#if manageable}
				{#if !account.emailVerifiedAt}
					<form method="POST" action="?/confirmEmail">
						<input type="hidden" name="userId" value={account.id} />
						<button class="menu-item" type="submit" role="menuitem">Confirm email</button>
					</form>
				{/if}
				{#if account.deletionScheduledAt}
					<form
						method="POST"
						action="?/cancelDeletion"
						onsubmit={confirmSubmit({
							title: `Cancel the scheduled deletion of ${account.email}?`,
							body: 'The account becomes active again.',
							confirmLabel: 'Cancel deletion'
						})}
					>
						<input type="hidden" name="userId" value={account.id} />
						<button class="menu-item" type="submit" role="menuitem">Cancel deletion</button>
					</form>
				{/if}
				{#if account.twoFactorEnabled}
					<form
						method="POST"
						action="?/resetTotp"
						onsubmit={confirmSubmit({
							title: `Turn off two-factor authentication for ${account.email}?`,
							body: 'They will sign in with their password alone until they set it up again.',
							confirmLabel: 'Reset 2FA',
							danger: true
						})}
					>
						<input type="hidden" name="userId" value={account.id} />
						<button class="menu-item" type="submit" role="menuitem">Reset 2FA</button>
					</form>
				{/if}
				<div class="menu-sep"></div>
				{#if account.suspendedAt}
					<form method="POST" action="?/unsuspend">
						<input type="hidden" name="userId" value={account.id} />
						<button class="menu-item" type="submit" role="menuitem">Unsuspend</button>
					</form>
				{:else}
					<form method="POST" action="?/suspend">
						<input type="hidden" name="userId" value={account.id} />
						<button class="menu-item danger" type="submit" role="menuitem">Suspend</button>
					</form>
				{/if}
				<form
					method="POST"
					action="?/deleteAccount"
					onsubmit={confirmSubmit({
						title: `Permanently delete ${account.email} and all their work?`,
						body: 'This cannot be undone.',
						confirmLabel: 'Delete account',
						danger: true
					})}
				>
					<input type="hidden" name="userId" value={account.id} />
					<button class="menu-item danger" type="submit" role="menuitem">Delete account</button>
				</form>
			{/if}
		</div>
	{/if}
</span>

<style>
	.actions-caret {
		display: inline-flex;
	}
	/* Narrower than the creation menu's default, which carries a help line. */
	.menu-host > .popover {
		min-width: 180px;
	}
</style>
