<script lang="ts">
	// The inline save-feedback line that sits in a settings form's action row:
	// an error in the danger colour, or a success note in the final-status
	// colour. The caller passes the already-narrowed strings (which scope/action
	// matched), so this stays a dumb presentational component.
	let {
		error = null,
		success = null,
		block = false
	}: {
		error?: string | null;
		success?: string | null;
		// Some rows render the message as a block paragraph rather than inline.
		block?: boolean;
	} = $props();
</script>

{#if error}
	{#if block}
		<p class="field-hint fs-error" role="alert">{error}</p>
	{:else}
		<span class="field-hint fs-error" role="alert">{error}</span>
	{/if}
{:else if success}
	{#if block}
		<p class="field-hint fs-ok" role="status">{success}</p>
	{:else}
		<span class="field-hint fs-ok" role="status">{success}</span>
	{/if}
{/if}

<style>
	.fs-error {
		color: var(--danger);
	}
	.fs-ok {
		color: var(--status-final);
	}
</style>
