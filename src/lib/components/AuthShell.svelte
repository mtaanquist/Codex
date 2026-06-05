<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	// The frame around every signed-out screen: the landing surface with a
	// single centered card.
	let { title, children }: { title: string; children: Snippet } = $props();
</script>

<div class="landing-surface">
	<nav class="landing-nav">
		<a class="brand" href={resolve('/')}>
			<span class="logo"><Icon name="feather" size={15} /></span>
			<span class="brand-name">Codex</span>
		</a>
		<span class="spacer"></span>
		<ThemeToggle />
	</nav>

	<main class="auth-main">
		<div class="auth-card">
			<h1 class="auth-title">{title}</h1>
			{@render children()}
		</div>
	</main>

	<footer class="landing-foot">Self-hosted · Invite-only</footer>
</div>

<style>
	.spacer {
		flex: 1;
	}
	.auth-main {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px 16px 56px;
	}
	.auth-card {
		width: 100%;
		max-width: 380px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg, 14px);
		box-shadow: var(--shadow);
		padding: 28px 28px 24px;
	}
	.auth-title {
		font-family: var(--font-serif);
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.015em;
		margin: 0 0 6px;
	}

	/* Shared shapes for the small amount of markup the auth pages carry. */
	.auth-card :global(form) {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin-top: 12px;
	}
	.auth-card :global(.auth-lede) {
		color: var(--text-muted);
		font-size: 13.5px;
		line-height: 1.55;
		margin: 0;
	}
	.auth-card :global(.auth-note) {
		color: var(--text-muted);
		font-size: 13.5px;
		line-height: 1.55;
		margin: 14px 0 0;
	}
	.auth-card :global(.btn) {
		justify-content: center;
		height: 38px;
	}
	.auth-card :global(.form-error) {
		color: var(--danger, #c0564f);
		font-size: 13px;
		margin: 0;
	}
	.auth-card :global(.auth-links) {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 16px 0 0;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}
	.auth-card :global(.auth-links a),
	.auth-card :global(.auth-links button) {
		font-size: 13px;
		color: var(--accent);
		text-decoration: none;
		background: none;
		border: 0;
		padding: 0;
		text-align: left;
		cursor: pointer;
		font-family: var(--font-ui);
	}
	.auth-card :global(.auth-links a:hover),
	.auth-card :global(.auth-links button:hover) {
		text-decoration: underline;
	}
</style>
