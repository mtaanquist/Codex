<script lang="ts">
	import Icon from './Icon.svelte';
	import { openPalette } from '$lib/palette.svelte';

	// The topbar trigger for the command palette; Ctrl+K does the same.
</script>

<button
	class="palette-btn"
	type="button"
	title="Search and commands (Ctrl+K)"
	aria-label="Search and commands"
	onclick={openPalette}
>
	<Icon name="search" size={14} />
	<span class="palette-btn-label">Search</span>
	<kbd>Ctrl K</kbd>
</button>

<style>
	.palette-btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 28px;
		padding: 0 9px;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--bg-inset);
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 12.5px;
		cursor: pointer;
	}
	.palette-btn:hover {
		color: var(--text);
		border-color: var(--accent-line);
	}
	.palette-btn-label {
		line-height: 1;
	}
	.palette-btn kbd {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--text-faint);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 4px;
		line-height: 1.2;
	}
	@media (max-width: 720px) {
		.palette-btn-label,
		.palette-btn kbd {
			display: none;
		}
	}
</style>
