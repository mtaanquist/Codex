<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import { docArticle } from '$lib/docs';
	import { help, closeHelp } from '$lib/help.svelte';
	import Icon from './Icon.svelte';

	const article = $derived(help.topic ? docArticle(help.topic) : null);

	let dialog = $state<HTMLElement>();
	$effect(() => {
		if (article && dialog) dialog.focus();
	});
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && help.topic) closeHelp();
	}}
/>

{#if article}
	<!-- Backdrop closes on click; Esc (above) and the close button cover keyboard. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="help-overlay" role="presentation" onclick={closeHelp}>
		<div
			class="help-modal"
			role="dialog"
			aria-modal="true"
			aria-label={article.title}
			tabindex="-1"
			bind:this={dialog}
			onclick={(event) => event.stopPropagation()}
		>
			<header class="help-modal-head">
				<span class="help-eyebrow">Help</span>
				<button
					class="help-close"
					type="button"
					title="Close (Esc)"
					aria-label="Close help"
					onclick={closeHelp}
				>
					<Icon name="close" size={16} />
				</button>
			</header>
			<!-- Trusted, committed markdown; renderMarkdown also escapes raw HTML. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<article class="prose">{@html renderMarkdown(article.body)}</article>
			<footer class="help-modal-foot">
				<a href={resolve('/docs')} onclick={closeHelp}>All help topics</a>
			</footer>
		</div>
	</div>
{/if}

<style>
	.help-overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.45);
		display: grid;
		place-items: center;
		padding: 24px;
	}
	.help-modal {
		width: min(40rem, 100%);
		max-height: 84vh;
		display: flex;
		flex-direction: column;
		background: var(--bg-elevated);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow);
		outline: none;
	}
	.help-modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 16px 10px;
		border-bottom: 1px solid var(--border);
	}
	.help-eyebrow {
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.help-close {
		border: 0;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 8px;
	}
	.help-close:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.prose {
		overflow: auto;
		padding: 18px 20px;
		font-family: var(--font-serif);
		line-height: 1.7;
		color: var(--text);
	}
	.prose :global(h1) {
		font-size: 1.45rem;
		margin: 0 0 0.85rem;
	}
	.prose :global(h2) {
		font-size: 1.1rem;
		margin: 1.5rem 0 0.4rem;
	}
	.prose :global(ul),
	.prose :global(ol) {
		padding-left: 1.4rem;
	}
	.prose :global(li) {
		margin: 0.3rem 0;
	}
	.prose :global(code) {
		font-family: var(--font-mono);
		font-size: 0.9em;
		background: var(--bg-inset);
		padding: 0.1em 0.35em;
		border-radius: var(--radius-sm);
	}
	.help-modal-foot {
		padding: 11px 16px;
		border-top: 1px solid var(--border);
		font-size: 0.9rem;
	}
	.help-modal-foot a {
		color: var(--accent);
	}
</style>
