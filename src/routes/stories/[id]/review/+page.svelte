<script lang="ts">
	import { resolve } from '$app/paths';
	import TopBar from '$lib/components/TopBar.svelte';
	import ReviewWorkspace from '$lib/components/ReviewWorkspace.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The author's own review pass: read the manuscript scene by scene, leave
	// comments and suggested edits, and work through everything guests have
	// left - reply, resolve, accept, reject.
	const seg = $derived({
		writeHref: resolve('/stories/[id]', { id: data.story.slug }),
		planHref: resolve('/stories/[id]/plan', { id: data.story.slug }),
		notesHref: resolve('/stories/[id]/notes', { id: data.story.slug })
	});
	// The author can open an entity's full details from its quick card.
	const planPath = $derived(resolve('/stories/[id]/plan', { id: data.story.slug }));
	const entityHref = (entity: { id: string }) => `${planPath}?entity=${entity.id}`;
</script>

<svelte:head>
	<title>{data.story.title} - Review - Codex</title>
</svelte:head>

<div class="app">
	<TopBar
		universe={{ slug: data.universe.slug, name: data.universe.name }}
		story={{ slug: data.story.slug, title: data.story.title }}
		help={{ topic: 'reviewing', label: 'reviewing' }}
	/>
	{#if form?.message}<p class="review-error" role="alert">{form.message}</p>{/if}
	<ReviewWorkspace
		chapters={data.chapters}
		scenes={data.scenes}
		threads={data.threads}
		suggestions={data.suggestions}
		role="author"
		storyId={data.story.id}
		book={{ title: data.story.title, subtitle: data.universe.name }}
		{seg}
		entities={data.mentionEntities}
		mentionMembers={data.mentionMembers}
		mentionPins={data.mentionPins}
		{entityHref}
		nonPrintingMarks={data.preferences.nonPrintingMarks}
		commandMarkers={data.preferences.commandMarkers}
		assistant={data.assistant.surfacesEnabled ? { name: data.assistant.name } : null}
	/>
</div>

<style>
	.review-error {
		position: fixed;
		top: 60px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		margin: 0;
		padding: 8px 16px;
		background: var(--danger-soft);
		color: var(--danger);
		border: 1px solid color-mix(in oklab, var(--danger) 40%, transparent);
		border-radius: var(--radius-md);
		font-size: 13px;
		box-shadow: var(--shadow);
	}
</style>
