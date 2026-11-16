<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import { dismiss } from '#lib/dismiss';
	import { menu } from '#lib/menu';
	import type { DraftRef } from '#lib/chrome';

	// The saved drafts of a story, from its library card: open the working
	// draft or any saved one, or save a new one. Sits beside the card's link,
	// never inside it, so the card stays one link.
	let {
		storySlug,
		storyTitle,
		drafts,
		compact = false
	}: { storySlug: string; storyTitle: string; drafts: DraftRef[]; compact?: boolean } = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();

	function close() {
		open = false;
	}
</script>

<span
	class="menu-host story-drafts"
	class:compact
	use:dismiss={{ enabled: open, close, refocus: () => trigger?.focus() }}
>
	<button
		class="btn btn-sm btn-secondary story-drafts-btn"
		type="button"
		bind:this={trigger}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Drafts of {storyTitle}"
		onclick={() => (open = !open)}
	>
		Drafts <Icon name="caret" size={11} />
	</button>
	{#if open}
		<div class="popover" role="menu" use:menu={{ close, refocus: () => trigger?.focus() }}>
			<a
				class="menu-item"
				role="menuitem"
				href={resolve('/stories/[id]', { id: storySlug })}
				onclick={close}
			>
				Working draft
			</a>
			<div class="menu-sep"></div>
			{#each drafts as draft (draft.id)}
				<a
					class="menu-item"
					role="menuitem"
					href={resolve('/stories/[id]/drafts/[draft=uuid]', { id: storySlug, draft: draft.id })}
					onclick={close}
				>
					{draft.label}
				</a>
			{/each}
			<div class="menu-sep"></div>
			<a
				class="menu-item"
				role="menuitem"
				href={resolve('/stories/[id]/settings/[[section]]', {
					id: storySlug,
					section: 'drafts'
				})}
				onclick={close}
			>
				Save as draft...
			</a>
		</div>
	{/if}
</span>

<style>
	.story-drafts {
		position: absolute;
		top: 26px;
		right: 26px;
		z-index: 2;
	}
	/* No cover in the compact view, so the status sits in that corner. */
	.story-drafts.compact {
		top: auto;
		right: var(--space-4);
		bottom: var(--space-3);
	}
	.story-drafts-btn {
		gap: var(--space-1);
	}
</style>
