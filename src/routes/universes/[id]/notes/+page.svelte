<script lang="ts">
	import { resolve } from '$app/paths';
	import NotesSidebar from '$lib/components/NotesSidebar.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import PanelStrip from '$lib/components/PanelStrip.svelte';
	import { visiblePanels } from '$lib/panels';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import AppBar from '$lib/components/AppBar.svelte';
	import { UNIVERSE_MODE_NOTE, universePath } from '$lib/chrome';
	import Icon from '$lib/components/Icon.svelte';
	import type { SaveStatus } from '$lib/components/SceneEditor.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saveStatus = $state<SaveStatus>('idle');
	const selectedId = $derived(data.selected?.id);
	$effect(() => {
		void selectedId;
		saveStatus = 'idle';
	});

	const notesPath = $derived(resolve('/universes/[id]/notes', { id: data.universe.slug }));
	const itemHref = $derived(data.selected ? `${notesPath}?note=${data.selected.id}` : notesPath);
	const currentBody = $derived(data.selected?.bodyMd ?? '');

	// A note mentions nothing, has no comments and no notes of its own, so
	// History is the only panel with a subject here: the pane wears a title
	// rather than a one-segment strip, and closes when no note is open.
	const panels = $derived(visiblePanels({ history: Boolean(data.selected) }));
</script>

<svelte:head>
	<title>{data.universe.name} - Notes - Codex</title>
</svelte:head>

<div class="app">
	<AppBar
		crumbs={universePath(data.universe)}
		{saveStatus}
		helpTopic="planning"
		helpLabel="notes"
	/>
	<div class="body" class:no-right={panels.length === 0}>
		<NotesSidebar
			notes={data.universeNotes}
			{selectedId}
			{notesPath}
			planHref={resolve('/universes/[id]/plan', { id: data.universe.slug })}
			writeHref={resolve('/universes/[id]/plan', { id: data.universe.slug })}
			reviewHref={resolve('/universes/[id]/plan', { id: data.universe.slug })}
			modeNote={UNIVERSE_MODE_NOTE}
			{form}
		/>
		<main class="pane center">
			{#if data.revisionPreview && data.selected}
				<div class="detail">
					<RevisionPreview
						revision={data.revisionPreview}
						{currentBody}
						entityType="note"
						entityId={data.selected.id}
						exitHref={itemHref}
					/>
				</div>
			{:else if data.selected}
				{#key data.selected.id}
					<div class="note-toolbar">
						<form method="POST" action="?/setPinned">
							<input type="hidden" name="noteId" value={data.selected.id} />
							<input type="hidden" name="pinned" value={data.selected.pinned ? 'false' : 'true'} />
							<button class="note-tool" type="submit">
								<Icon name="pin" size={13} />
								{data.selected.pinned ? 'Unpin' : 'Pin'}
							</button>
						</form>
						<form
							method="POST"
							action="?/deleteNote"
							onsubmit={(e) => {
								if (!confirm('Delete this note? This cannot be undone.')) e.preventDefault();
							}}
						>
							<input type="hidden" name="noteId" value={data.selected.id} />
							<button class="note-tool danger" type="submit">
								<Icon name="trash" size={13} /> Delete
							</button>
						</form>
					</div>
					<NoteEditor note={data.selected} onStatus={(status) => (saveStatus = status)} />
				{/key}
			{:else}
				<div class="empty-state">
					<p class="empty-state-text">Select a note, or make a new one in the sidebar.</p>
				</div>
			{/if}
		</main>
		{#if data.selected}
			{@const openNote = data.selected}
			<aside class="pane right">
				<PanelStrip {panels} active="history" onSelect={() => {}} sub="this note">
					{#snippet panel()}
						<RevisionHistory
							entityType="note"
							entityId={openNote.id}
							revisions={data.revisionRows}
							previewId={data.revisionPreview?.id}
							previewHref={(revisionId) => `${itemHref}&revision=${revisionId}`}
						/>
						<p class="panel-note">
							A note has versions like anything else you type here. Codex autosaves; name a
							checkpoint when you want to find your way back to this wording.
						</p>
					{/snippet}
				</PanelStrip>
			</aside>
		{/if}
	</div>
</div>

<style>
	.note-toolbar {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-bottom: 6px;
	}
	.note-tool {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		background: none;
		color: var(--text-muted);
		font-size: 12.5px;
		padding: 5px 10px;
		cursor: pointer;
	}
	.note-tool:hover {
		color: var(--text);
		border-color: var(--accent-line);
	}
	.note-tool.danger:hover {
		color: var(--danger, #b00020);
		border-color: var(--danger, #b00020);
	}
</style>
