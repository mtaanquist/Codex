<script lang="ts">
	import { resolve } from '$app/paths';

	// Opens the relevant help article. `label` names what is being explained, for
	// the accessible name and tooltip (e.g. "the editor").
	let { topic, label }: { topic: string; label: string } = $props();
</script>

<a
	class="help-link"
	href={resolve('/docs/[topic]', { topic })}
	title={`Help: ${label}`}
	aria-label={`Help: ${label}`}
>
	?
</a>

<style>
	.help-link {
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-inset);
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		text-decoration: none;
		vertical-align: middle;
	}
	.help-link:hover {
		border-color: var(--accent-line);
		color: var(--accent);
	}
</style>
