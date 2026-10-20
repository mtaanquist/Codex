<script lang="ts">
	import { resolve } from '$app/paths';
	import NotesWorkspace from '$lib/components/NotesWorkspace.svelte';
	import { storyPath } from '$lib/chrome';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>{data.story.title} - Notes - Codex</title>
</svelte:head>

<NotesWorkspace
	crumbs={storyPath(data.universe, { ...data.story, reading: data.reading })}
	notes={data.storyNotes}
	universeNotes={data.universeNotes}
	universeNotesPath={resolve('/universes/[id]/notes', { id: data.universe.slug })}
	notesPath={resolve('/stories/[id]/notes', { id: data.story.slug })}
	planHref={resolve('/stories/[id]/plan', { id: data.story.slug })}
	writeHref={resolve('/stories/[id]', { id: data.story.slug })}
	reviewHref={resolve('/stories/[id]/review', { id: data.story.slug })}
	selected={data.selected}
	revisionRows={data.revisionRows}
	revisionPreview={data.revisionPreview}
	{form}
/>
