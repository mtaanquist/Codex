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
	<div class="modal-backdrop" role="presentation" onclick={closeHelp}>
		<div
			class="modal-panel modal-lg"
			role="dialog"
			aria-modal="true"
			aria-label={article.title}
			tabindex="-1"
			bind:this={dialog}
			onclick={(event) => event.stopPropagation()}
		>
			<header class="modal-head">
				<div class="modal-head-main">
					<span class="modal-kind">Help</span>
				</div>
				<button
					class="icon-btn sm"
					type="button"
					title="Close (Esc)"
					aria-label="Close help"
					onclick={closeHelp}
				>
					<Icon name="close" size={15} />
				</button>
			</header>
			<!-- Trusted, committed markdown; renderMarkdown also escapes raw HTML. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<article class="modal-body prose">{@html renderMarkdown(article.body)}</article>
			<footer class="modal-foot">
				<div class="modal-foot-note">
					<a href={resolve('/docs')} onclick={closeHelp}>All help topics</a>
				</div>
			</footer>
		</div>
	</div>
{/if}

<style>
	/* The overlay, panel, head and footer come from the modal primitive; what is
	   left here is the article's own typography. */
	.prose {
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
	.modal-foot-note a {
		color: var(--accent);
	}
</style>
