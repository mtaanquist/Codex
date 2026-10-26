<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { dismiss } from '$lib/dismiss';
	import { menu } from '$lib/menu';
	import { authorInitials } from '$lib/review-ui';
	import Icon from './Icon.svelte';
	import ThemePicker from './ThemePicker.svelte';

	type MenuUser = { displayName: string; email: string; isAdmin: boolean };
	const user = $derived(page.data.user as MenuUser | null);

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
</script>

{#if user}
	<div
		class="avatar-menu"
		class:open
		use:dismiss={{
			enabled: open,
			close: () => (open = false),
			refocus: () => trigger?.focus()
		}}
	>
		<button
			bind:this={trigger}
			class="avatar"
			type="button"
			title="Account"
			aria-label="Account menu"
			aria-haspopup="menu"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			{authorInitials(user.displayName)}
		</button>

		{#if open}
			<div
				class="avatar-dropdown"
				role="menu"
				use:menu={{ close: () => (open = false), refocus: () => trigger?.focus() }}
			>
				<div class="avatar-dd-head">
					<span class="avatar-dd-pic">{authorInitials(user.displayName)}</span>
					<div>
						<div class="avatar-dd-name">{user.displayName}</div>
						<div class="avatar-dd-mail">{user.email}</div>
					</div>
				</div>

				<div class="avatar-dd-sep"></div>
				<div class="avatar-dd-group">
					<a
						class="avatar-dd-item"
						role="menuitem"
						href={resolve('/account/[[section]]', {})}
						onclick={() => (open = false)}
					>
						<Icon name="gear" size={16} />
						<span class="lbl">Account settings</span>
					</a>
					{#if user.isAdmin}
						<a
							class="avatar-dd-item"
							role="menuitem"
							href={resolve('/admin/[[section]]', {})}
							onclick={() => (open = false)}
						>
							<Icon name="shield" size={16} />
							<span class="lbl">Admin panel</span>
							<span class="avatar-dd-tag">Admin</span>
						</a>
					{/if}
				</div>

				<div class="avatar-dd-sep"></div>
				<div class="avatar-dd-group">
					<ThemePicker variant="items" />
					<a
						class="avatar-dd-item"
						role="menuitem"
						href={resolve('/docs/[topic]', { topic: 'shortcuts' })}
						onclick={() => (open = false)}
					>
						<Icon name="book" size={16} />
						<span class="lbl">Keyboard shortcuts</span>
					</a>
				</div>

				<div class="avatar-dd-sep"></div>
				<div class="avatar-dd-group">
					<form method="POST" action={resolve('/logout')}>
						<button class="avatar-dd-item danger" role="menuitem" type="submit">
							<Icon name="logout" size={16} />
							<span class="lbl">Sign out</span>
						</button>
					</form>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* The dropdown form wrapper should not break the item layout. */
	.avatar-dd-group form {
		display: contents;
	}
</style>
