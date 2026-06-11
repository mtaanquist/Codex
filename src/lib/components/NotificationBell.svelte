<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import type { NotificationItem } from '$lib/notifications';
	import { dismiss } from '$lib/dismiss';
	import { relativeShort } from '$lib/format';

	// The topbar bell: unread badge, a dropdown of recent notifications,
	// click marks read and follows the link when there is one.

	let unread = $state(0);
	let items = $state<NotificationItem[]>([]);
	let open = $state(false);
	let loaded = $state(false);

	async function load() {
		try {
			const response = await fetch('/api/notifications');
			if (!response.ok) return;
			const data = (await response.json()) as { unread: number; items: NotificationItem[] };
			unread = data.unread;
			items = data.items;
			loaded = true;
		} catch {
			/* the bell just stays empty */
		}
	}

	$effect(() => {
		void load();
	});

	function toggle() {
		open = !open;
		if (open) void load();
	}

	async function markRead(body: { ids?: string[]; all?: boolean }) {
		try {
			await fetch('/api/notifications/read', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			/* read state catches up on the next load */
		}
	}

	async function openItem(item: NotificationItem) {
		if (!item.read) {
			item.read = true;
			unread = Math.max(0, unread - 1);
			void markRead({ ids: [item.id] });
		}
		if (item.href) {
			open = false;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path built server-side
			await goto(item.href);
		}
	}

	function markAll() {
		items = items.map((item) => ({ ...item, read: true }));
		unread = 0;
		void markRead({ all: true });
	}
</script>

<div class="bell" use:dismiss={{ enabled: open, close: () => (open = false) }}>
	<button
		class="icon-btn bell-btn"
		type="button"
		title="Notifications"
		aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
		aria-expanded={open}
		onclick={toggle}
	>
		<Icon name="bell" size={16} />
		{#if unread > 0}
			<span class="bell-badge">{unread > 9 ? '9+' : unread}</span>
		{/if}
	</button>

	{#if open}
		<div class="bell-menu">
			<div class="bell-head">
				<span class="bell-title">Notifications</span>
				{#if unread > 0}
					<button class="bell-mark-all" type="button" onclick={markAll}>Mark all read</button>
				{/if}
			</div>
			{#if items.length === 0}
				<p class="bell-empty">{loaded ? 'Nothing yet.' : 'Loading...'}</p>
			{:else}
				<ul class="bell-list">
					{#each items as item (item.id)}
						<li>
							<button class="bell-item" class:unread={!item.read} onclick={() => openItem(item)}>
								<span class="bell-dot" aria-hidden="true"></span>
								<span class="bell-text">
									<span class="bell-item-title">{item.title}</span>
									{#if item.detail}
										<span class="bell-item-detail">{item.detail}</span>
									{/if}
								</span>
								<span class="bell-age">{relativeShort(item.createdAt)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.bell {
		position: relative;
	}
	.bell-btn {
		position: relative;
	}
	.bell-badge {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: 8px;
		background: var(--accent);
		color: var(--accent-contrast, #fff);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
		text-align: center;
	}
	.bell-menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		width: 320px;
		max-height: 420px;
		overflow-y: auto;
		background: var(--bg-elevated);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow);
		z-index: 60;
	}
	.bell-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
	}
	.bell-title {
		font-size: 12px;
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.bell-mark-all {
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
		padding: 0;
	}
	.bell-empty {
		margin: 0;
		padding: 18px 12px;
		font-size: 13px;
		color: var(--text-muted);
		text-align: center;
	}
	.bell-list {
		list-style: none;
		margin: 0;
		padding: 4px;
		display: grid;
		gap: 2px;
	}
	.bell-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: none;
		text-align: left;
		cursor: pointer;
		color: var(--text);
	}
	.bell-item:hover {
		background: var(--bg-hover);
	}
	.bell-dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		margin-top: 5px;
		border-radius: 50%;
		background: transparent;
	}
	.bell-item.unread .bell-dot {
		background: var(--accent);
	}
	.bell-text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.bell-item-title {
		font-size: 13px;
		line-height: 1.35;
	}
	.bell-item.unread .bell-item-title {
		font-weight: 650;
	}
	.bell-item-detail {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.bell-age {
		margin-left: auto;
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-faint);
		padding-top: 2px;
	}
</style>
