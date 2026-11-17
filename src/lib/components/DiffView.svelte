<script lang="ts">
	import { diffLines } from 'diff';

	// Two versions of a text, line by line: what `to` added over `from` and
	// what it took out. Used wherever an older text is compared with a newer.
	// Most screen readers do not announce ins and del, so each part also says
	// what it is in hidden text.
	let { from, to, class: className = '' }: { from: string; to: string; class?: string } = $props();

	const parts = $derived(diffLines(from, to));
</script>

<div class="diff-view {className}">
	{#each parts as part, index (index)}{#if part.added}<ins class="diff-add"
				><span class="visually-hidden">Added: </span>{part.value}<span class="visually-hidden"
					>(end of added text)</span
				></ins
			>{:else if part.removed}<del class="diff-del"
				><span class="visually-hidden">Removed: </span>{part.value}<span class="visually-hidden"
					>(end of removed text)</span
				></del
			>{:else}<span>{part.value}</span>{/if}{/each}
</div>

<style>
	.diff-view {
		white-space: pre-wrap;
		line-height: 1.7;
	}
	.diff-add {
		background: color-mix(in oklab, var(--status-final) 22%, transparent);
		text-decoration: none;
		border-radius: 3px;
	}
	/* The hidden labels are for screen readers; keep them out of copied text. */
	.diff-view :global(.visually-hidden) {
		user-select: none;
	}
	.diff-del {
		background: color-mix(in oklab, var(--danger) 18%, transparent);
		text-decoration: line-through;
		border-radius: 3px;
	}
</style>
