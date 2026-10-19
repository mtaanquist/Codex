<script lang="ts">
	import { resolve } from '$app/paths';
	import NotesWorkspace from '$lib/components/NotesWorkspace.svelte';
	import { UNIVERSE_MODE_NOTE, universePath } from '$lib/chrome';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const planHref = $derived(resolve('/universes/[id]/plan', { id: data.universe.slug }));
</script>

<svelte:head>
	<title>{data.universe.name} - Notes - Codex</title>
</svelte:head>

<NotesWorkspace
	crumbs={universePath(data.universe)}
	notes={data.universeNotes}
	notesPath={resolve('/universes/[id]/notes', { id: data.universe.slug })}
	{planHref}
	writeHref={planHref}
	reviewHref={planHref}
	modeNote={UNIVERSE_MODE_NOTE}
	selected={data.selected}
	revisionRows={data.revisionRows}
	revisionPreview={data.revisionPreview}
	{form}
/>
