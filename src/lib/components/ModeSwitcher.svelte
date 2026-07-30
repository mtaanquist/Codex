<script lang="ts">
	// The Write/Plan/Notes/Review strip above the left sidebar. It is always
	// the same four modes in the same order at the same width, wherever it
	// appears. The active mode renders as the lit button; a mode you cannot
	// use is switched off in place rather than removed, and the caller passes
	// the one line under the strip that says why.
	export type Mode = 'write' | 'plan' | 'notes' | 'review';

	let {
		active,
		hrefs,
		note
	}: {
		active: Mode;
		hrefs: Partial<Record<Mode, string | 'disabled'>>;
		// Rendered under the strip, not as a tooltip, so it can be read by
		// keyboard and by screen reader.
		note?: string;
	} = $props();

	const MODES: { mode: Mode; label: string }[] = [
		{ mode: 'write', label: 'Write' },
		{ mode: 'plan', label: 'Plan' },
		{ mode: 'notes', label: 'Notes' },
		{ mode: 'review', label: 'Review' }
	];
</script>

<div class="seg full mode-strip" aria-label="Mode">
	{#each MODES as { mode, label } (mode)}
		{#if mode === active}
			<button class="seg-btn active" type="button" aria-current="page">{label}</button>
		{:else if hrefs[mode] && hrefs[mode] !== 'disabled'}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the paths) -->
			<a class="seg-btn" href={hrefs[mode]}>{label}</a>
		{:else}
			<span class="seg-btn" aria-disabled="true">{label}</span>
		{/if}
	{/each}
</div>
{#if note}
	<p class="mode-note">{note}</p>
{/if}
