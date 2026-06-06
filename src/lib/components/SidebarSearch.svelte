<script lang="ts">
	import Icon from './Icon.svelte';

	// The left pane's filter field: narrows the list below as you type.
	// The page owns the query; this is just the input and its clear button.
	let {
		query = $bindable(''),
		placeholder
	}: {
		query?: string;
		placeholder: string;
	} = $props();
</script>

<div class="search-bar">
	<Icon name="search" size={14} />
	<input type="text" bind:value={query} {placeholder} spellcheck="false" aria-label={placeholder} />
	{#if query}
		<button
			class="search-clear"
			type="button"
			title="Clear"
			aria-label="Clear"
			onclick={() => (query = '')}
		>
			&times;
		</button>
	{/if}
</div>
