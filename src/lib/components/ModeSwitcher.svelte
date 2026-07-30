<script lang="ts">
	// The Write/Plan/Review strip above the left sidebar. It is always the
	// same three modes in the same order at the same width, wherever it
	// appears. Notes is not a mode: notes ride in the right panel of Write
	// and Plan, and the full Notes page opens from there. The active mode
	// renders as the lit button; a mode you cannot use is switched off in
	// place rather than removed, and the caller passes the one line under
	// the strip that says why. A page outside the three passes active null,
	// so nothing is lit.
	export type Mode = 'write' | 'plan' | 'review';

	let {
		active,
		hrefs,
		note
	}: {
		// null on a page that is not one of the three modes (insights reads
		// the whole universe; the Notes page sits beside the modes). All
		// three stay live; the note says why none is lit, because a strip
		// that lies about where you are is worse than a strip with nothing
		// lit.
		active: Mode | null;
		hrefs: Partial<Record<Mode, string | 'disabled'>>;
		// Rendered under the strip, not as a tooltip, so it can be read by
		// keyboard and by screen reader.
		note?: string;
	} = $props();

	const MODES: { mode: Mode; label: string }[] = [
		{ mode: 'write', label: 'Write' },
		{ mode: 'plan', label: 'Plan' },
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
