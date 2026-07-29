<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import { cycleTheme, currentTheme, nextTheme } from '$lib/theme';
	import { dismiss } from '$lib/dismiss';
	import { authorInitials } from '$lib/review-ui';
	import Icon from './Icon.svelte';
	import type { ConcreteTheme } from '$lib/appearance';

	type MenuUser = { displayName: string; email: string; isAdmin: boolean };
	const user = $derived(page.data.user as MenuUser | null);

	let open = $state(false);

	// The same dark -> light -> warm cycle as the bar's theme tool; accent is
	// left untouched, and cycleTheme handles the localStorage mirror and the
	// account persist.
	let theme = $state<ConcreteTheme>(browser ? currentTheme() : 'dark');
</script>

{#if user}
	<div class="avatar-menu" class:open use:dismiss={{ enabled: open, close: () => (open = false) }}>
		<button
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

		<div class="avatar-dropdown" role="menu">
			<div class="avatar-dd-head">
				<span class="avatar-dd-pic">{authorInitials(user.displayName)}</span>
				<div>
					<div class="avatar-dd-name">{user.displayName}</div>
					<div class="avatar-dd-mail">{user.email}</div>
				</div>
			</div>

			<div class="avatar-dd-sep"></div>
			<div class="avatar-dd-group">
				<a class="avatar-dd-item" role="menuitem" href={resolve('/account/[[section]]', {})}>
					<Icon name="gear" size={16} />
					<span class="lbl">Account settings</span>
				</a>
				{#if user.isAdmin}
					<a class="avatar-dd-item" role="menuitem" href={resolve('/admin/[[section]]', {})}>
						<Icon name="shield" size={16} />
						<span class="lbl">Admin panel</span>
						<span class="avatar-dd-tag">Admin</span>
					</a>
				{/if}
			</div>

			<div class="avatar-dd-sep"></div>
			<div class="avatar-dd-group">
				<button
					class="avatar-dd-item"
					role="menuitem"
					type="button"
					onclick={() => (theme = cycleTheme(true))}
				>
					{#if theme === 'dark'}
						<Icon name="sun" size={16} />
					{:else}
						<Icon name="moon" size={16} />
					{/if}
					<span class="lbl">Switch to {nextTheme(theme)}</span>
				</button>
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
	</div>
{/if}

<style>
	/* The dropdown form wrapper should not break the item layout. */
	.avatar-dd-group form {
		display: contents;
	}
</style>
