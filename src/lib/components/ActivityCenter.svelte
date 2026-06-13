<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import { activity, dismissActivity, type ActivityItem } from '$lib/activity.svelte';

	// The activity center: a stack of cards in the corner showing the Assistant's
	// in-progress work (reviews, summary passes). A running task keeps its card
	// with a spinner until it finishes; a finished one flips to done or failed and
	// clears itself shortly after. Distinct from the notification bell, which keeps
	// a lasting record; this is the "something is happening right now" surface.

	async function open(item: ActivityItem) {
		if (!item.href) return;
		dismissActivity(item.id);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path built by the caller
		await goto(item.href);
	}
</script>

{#if activity.items.length > 0}
	<div class="activity" aria-live="polite">
		{#each activity.items as item (item.id)}
			<div class="activity-card" class:failed={item.state === 'failed'}>
				<span class="activity-glyph" aria-hidden="true">
					{#if item.state === 'running'}
						<span class="spinner"></span>
					{:else if item.state === 'done'}
						<Icon name="check" size={15} />
					{:else}
						<Icon name="close" size={15} />
					{/if}
				</span>
				<div class="activity-body">
					<span class="activity-label">{item.label}</span>
					{#if item.detail}<span class="activity-detail">{item.detail}</span>{/if}
					{#if item.href && item.state !== 'failed'}
						<button class="activity-link" type="button" onclick={() => open(item)}>
							View <Icon name="arrow-out" size={11} />
						</button>
					{/if}
				</div>
				<button
					class="activity-x"
					type="button"
					title="Dismiss"
					aria-label="Dismiss"
					onclick={() => dismissActivity(item.id)}
				>
					<Icon name="close" size={13} />
				</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.activity {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 90;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: min(340px, calc(100vw - 32px));
		font-family: var(--font-ui);
	}
	.activity-card {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 11px 12px;
	}
	.activity-card.failed {
		border-color: color-mix(in oklab, var(--danger, #c0564f) 55%, var(--border));
	}
	.activity-glyph {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-top: 1px;
		color: var(--accent, var(--text));
	}
	.activity-card.failed .activity-glyph {
		color: var(--danger, #c0564f);
	}
	.spinner {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid color-mix(in oklab, var(--accent, var(--text)) 30%, transparent);
		border-top-color: var(--accent, var(--text));
		animation: activity-spin 0.7s linear infinite;
	}
	@keyframes activity-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.activity-body {
		flex: 1 1 auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.activity-label {
		font-size: 13px;
		font-weight: 550;
		color: var(--text);
	}
	.activity-detail {
		font-size: 12px;
		color: var(--text-faint);
	}
	.activity-link {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-top: 4px;
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent, var(--text));
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.activity-link:hover {
		text-decoration: underline;
	}
	.activity-x {
		flex: 0 0 auto;
		border: 0;
		background: none;
		color: var(--text-faint);
		padding: 1px;
		cursor: pointer;
		line-height: 0;
	}
	.activity-x:hover {
		color: var(--text);
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2s;
		}
	}
</style>
