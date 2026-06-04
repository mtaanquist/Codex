<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { browser } from '$app/environment';

	type MenuUser = { displayName: string; email: string; isAdmin: boolean };
	const user = $derived(page.data.user as MenuUser | null);

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		const first = parts[0]?.[0] ?? '';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase() || '?';
	}

	let open = $state(false);
	let root = $state<HTMLElement>();

	// Flip data-theme now for an instant response, mirror it to localStorage so a
	// reload keeps it, and persist it to the account so the next navigation (where
	// the layout re-applies the saved preference) does not revert it. Accent is
	// left untouched.
	let dark = $state(browser && document.documentElement.getAttribute('data-theme') === 'dark');
	function toggleTheme() {
		const next = dark ? 'light' : 'dark';
		document.documentElement.setAttribute('data-theme', next);
		try {
			localStorage.setItem('codex-theme', next);
		} catch {
			/* preference just does not persist */
		}
		dark = !dark;
		fetch('/api/appearance', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme: next })
		}).catch(() => {
			/* the optimistic flip stands; it just will not survive a reload */
		});
	}

	function onWindowClick(event: MouseEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}
	function onWindowKey(event: KeyboardEvent) {
		if (event.key === 'Escape') open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

{#if user}
	<div class="avatar-menu" class:open bind:this={root}>
		<button
			class="avatar"
			type="button"
			title="Account"
			aria-label="Account menu"
			aria-haspopup="menu"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			{initials(user.displayName)}
		</button>

		<div class="avatar-dropdown" role="menu">
			<div class="avatar-dd-head">
				<span class="avatar-dd-pic">{initials(user.displayName)}</span>
				<div>
					<div class="avatar-dd-name">{user.displayName}</div>
					<div class="avatar-dd-mail">{user.email}</div>
				</div>
			</div>

			<div class="avatar-dd-sep"></div>
			<div class="avatar-dd-group">
				<a class="avatar-dd-item" role="menuitem" href={resolve('/account')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><circle cx="12" cy="12" r="3" /><path
							d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
						/></svg
					>
					<span class="lbl">Account settings</span>
				</a>
				{#if user.isAdmin}
					<a class="avatar-dd-item" role="menuitem" href={resolve('/admin')}>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z" /></svg
						>
						<span class="lbl">Admin panel</span>
						<span class="avatar-dd-tag">Admin</span>
					</a>
				{/if}
			</div>

			<div class="avatar-dd-sep"></div>
			<div class="avatar-dd-group">
				<button class="avatar-dd-item" role="menuitem" type="button" onclick={toggleTheme}>
					{#if dark}
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							stroke-linejoin="round"
							><circle cx="12" cy="12" r="5" /><path
								d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"
							/></svg
						>
						<span class="lbl">Switch to light</span>
					{:else}
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg
						>
						<span class="lbl">Switch to dark</span>
					{/if}
				</button>
			</div>

			<div class="avatar-dd-sep"></div>
			<div class="avatar-dd-group">
				<form method="POST" action={resolve('/logout')}>
					<button class="avatar-dd-item danger" role="menuitem" type="submit">
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
							><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline
								points="16 17 21 12 16 7"
							/><line x1="21" y1="12" x2="9" y2="12" /></svg
						>
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
