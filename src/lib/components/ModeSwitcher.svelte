<script lang="ts">
	// The Write/Plan/Notes/Review strip above the left sidebar, shared by the
	// four workspace views. The active mode renders as the lit button; every
	// other mode is a link, a disabled button ('disabled', the guest reviewer
	// case), or absent entirely (a universe view with no Write).
	export type Mode = 'write' | 'plan' | 'notes' | 'review';

	let {
		active,
		hrefs
	}: {
		active: Mode;
		hrefs: Partial<Record<Mode, string | 'disabled'>>;
	} = $props();

	const MODES: { mode: Mode; label: string }[] = [
		{ mode: 'write', label: 'Write' },
		{ mode: 'plan', label: 'Plan' },
		{ mode: 'notes', label: 'Notes' },
		{ mode: 'review', label: 'Review' }
	];
</script>

<div class="seg full">
	{#each MODES as { mode, label } (mode)}
		{#if mode === active}
			<button class="seg-btn active" type="button">{label}</button>
		{:else if hrefs[mode] === 'disabled'}
			<button class="seg-btn" type="button" disabled>{label}</button>
		{:else if hrefs[mode]}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the paths) -->
			<a class="seg-btn" href={hrefs[mode]}>{label}</a>
		{/if}
	{/each}
</div>
