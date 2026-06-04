<script lang="ts">
	import { openHelp } from '$lib/help.svelte';

	// Opens the relevant help article in a modal. `label` names what is being
	// explained, for the accessible name and tooltip (e.g. "the editor").
	let { topic, label }: { topic: string; label: string } = $props();
</script>

<button
	class="help-link"
	type="button"
	title={`Help: ${label}`}
	aria-label={`Help: ${label}`}
	onclick={() => openHelp(topic)}
>
	?
</button>

<style>
	.help-link {
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-inset);
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		vertical-align: middle;
	}
	.help-link:hover {
		border-color: var(--accent-line);
		color: var(--accent);
	}
</style>
