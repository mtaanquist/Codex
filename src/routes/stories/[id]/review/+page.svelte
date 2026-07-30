<script lang="ts">
	import { resolve } from '$app/paths';
	import AppBar from '$lib/components/AppBar.svelte';
	import { storyPath } from '$lib/chrome';
	import ReviewWorkspace from '$lib/components/ReviewWorkspace.svelte';
	import ReviewModal from '$lib/components/ReviewModal.svelte';
	import type { SaveStatus } from '$lib/components/SceneEditor.svelte';
	import { editorStyleVars } from '$lib/page-setup';
	import { focusMode } from '$lib/focus-mode.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saveStatus = $state<SaveStatus>('idle');

	// The editable centre matches the Write editor's font, line spacing, and
	// default alignment.
	const editorStyle = $derived(
		editorStyleVars({ ...data.preferences, textAlign: data.pageSetup.textAlign })
	);

	// The author's own review pass: read the manuscript scene by scene, leave
	// comments and suggested edits, and work through everything guests have
	// left - reply, resolve, accept, reject.
	const seg = $derived({
		writeHref: resolve('/stories/[id]', { id: data.story.slug }),
		planHref: resolve('/stories/[id]/plan', { id: data.story.slug })
	});
	// The author can open an entity's full details from its quick card.
	const planPath = $derived(resolve('/stories/[id]/plan', { id: data.story.slug }));
	const entityHref = (entity: { id: string }) => `${planPath}?entity=${entity.id}`;
</script>

<svelte:head>
	<title>{data.story.title} - Review - Codex</title>
</svelte:head>

<div class="app" class:focus-mode={focusMode.on}>
	<AppBar
		crumbs={storyPath(data.universe, { ...data.story, reading: data.reading })}
		helpTopic="reviewing"
		helpLabel="reviewing"
		{saveStatus}
	/>
	{#if form?.message}<p class="review-error" role="alert">{form.message}</p>{/if}
	<ReviewWorkspace
		chapters={data.chapters}
		scenes={data.scenes}
		threads={data.threads}
		suggestions={data.suggestions}
		role="author"
		storyId={data.story.id}
		storySlug={data.story.slug}
		book={{ title: data.story.title, subtitle: data.universe.name }}
		{seg}
		entities={data.mentionEntities}
		mentionMembers={data.mentionMembers}
		mentionPins={data.mentionPins}
		{entityHref}
		nonPrintingMarks={data.preferences.nonPrintingMarks}
		commandMarkers={data.preferences.commandMarkers}
		{editorStyle}
		assistant={data.assistant.tabEnabled
			? {
					name: data.assistant.name,
					surfacesEnabled: data.assistant.surfacesEnabled,
					muted: data.assistant.muted
				}
			: null}
		assistantChat={data.assistantChat}
		onSaveStatus={(status) => (saveStatus = status)}
	/>
	{#if data.assistant.surfacesEnabled}
		<ReviewModal
			storyId={data.story.id}
			storySlug={data.story.slug}
			chapters={data.chapters}
			scenes={data.scenes}
		/>
	{/if}
</div>
