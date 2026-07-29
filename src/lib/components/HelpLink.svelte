<script lang="ts">
	import { resolve } from '$app/paths';

	// The inline question mark beside a heading. It opens the relevant help
	// article as a page, the same destination as the one in the app bar, so
	// help never opens over the top of your work. `label` names what is being
	// explained, for the accessible name and tooltip (e.g. "the editor").
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
		padding: 0;
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
