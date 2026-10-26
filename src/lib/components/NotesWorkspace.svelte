<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import NotesSidebar from './NotesSidebar.svelte';
	import NoteEditor from './NoteEditor.svelte';
	import PanelStrip from './PanelStrip.svelte';
	import RevisionHistory from './RevisionHistory.svelte';
	import RevisionPreview from './RevisionPreview.svelte';
	import AppBar from './AppBar.svelte';
	import Icon from './Icon.svelte';
	import type { SaveStatus } from './SceneEditor.svelte';
	import { visiblePanels } from '$lib/panels';
	import type { Crumb } from '$lib/chrome';

	type SidebarProps = ComponentProps<typeof NotesSidebar>;

	// The Notes view, shared by the story and universe scopes. The pages load
	// the notes and pass in the scope's crumbs and mode-strip links.
	let {
		crumbs,
		notes,
		universeNotes,
		universeNotesPath,
		notesPath,
		planHref,
		writeHref,
		reviewHref,
		modeNote,
		selected,
		revisionRows,
		revisionPreview,
		form
	}: {
		crumbs: Crumb[];
		notes: SidebarProps['notes'];
		universeNotes?: SidebarProps['universeNotes'];
		universeNotesPath?: string;
		notesPath: string;
		planHref: string;
		writeHref?: string;
		reviewHref?: string;
		modeNote?: string;
		selected: (ComponentProps<typeof NoteEditor>['note'] & { pinned: boolean }) | null;
		revisionRows: ComponentProps<typeof RevisionHistory>['revisions'];
		revisionPreview: ComponentProps<typeof RevisionPreview>['revision'] | null;
		form: SidebarProps['form'];
	} = $props();

	let saveStatus = $state<SaveStatus>('idle');
	const selectedId = $derived(selected?.id);
	$effect(() => {
		void selectedId;
		saveStatus = 'idle';
	});

	const itemHref = $derived(selected ? `${notesPath}?note=${selected.id}` : notesPath);
	const currentBody = $derived(selected?.bodyMd ?? '');

	// A note mentions nothing, has no comments and no notes of its own, so
	// History is the only panel with a subject here: the pane wears a title
	// rather than a one-segment strip, and closes when no note is open.
	const panels = $derived(visiblePanels({ history: Boolean(selected) }));
</script>

<div class="app">
	<AppBar {crumbs} {saveStatus} helpTopic="planning" helpLabel="notes" />
	<div class="body" class:no-right={panels.length === 0}>
		<NotesSidebar
			{notes}
			{universeNotes}
			{universeNotesPath}
			{selectedId}
			{notesPath}
			{planHref}
			{writeHref}
			{reviewHref}
			{modeNote}
			{form}
		/>
		<main class="pane center">
			{#if revisionPreview && selected}
				<div class="detail">
					<RevisionPreview
						revision={revisionPreview}
						{currentBody}
						entityType="note"
						entityId={selected.id}
						exitHref={itemHref}
					/>
				</div>
			{:else if selected}
				{#key selected.id}
					<div class="note-toolbar">
						<form method="POST" action="?/setPinned">
							<input type="hidden" name="noteId" value={selected.id} />
							<input type="hidden" name="pinned" value={selected.pinned ? 'false' : 'true'} />
							<button class="note-tool" type="submit">
								<Icon name="pin" size={13} />
								{selected.pinned ? 'Unpin' : 'Pin'}
							</button>
						</form>
						<form
							method="POST"
							action="?/deleteNote"
							onsubmit={(e) => {
								if (!confirm('Delete this note? This cannot be undone.')) e.preventDefault();
							}}
						>
							<input type="hidden" name="noteId" value={selected.id} />
							<button class="note-tool danger" type="submit">
								<Icon name="trash" size={13} /> Delete
							</button>
						</form>
					</div>
					<NoteEditor note={selected} onStatus={(status) => (saveStatus = status)} />
				{/key}
			{:else}
				<div class="empty-state">
					<p class="empty-state-text">Select a note, or make a new one in the sidebar.</p>
				</div>
			{/if}
		</main>
		{#if selected}
			{@const openNote = selected}
			<aside class="pane right">
				<PanelStrip {panels} active="history" onSelect={() => {}} sub="this note">
					{#snippet panel()}
						<RevisionHistory
							entityType="note"
							entityId={openNote.id}
							revisions={revisionRows}
							previewId={revisionPreview?.id}
							previewHref={(revisionId) => `${itemHref}&revision=${revisionId}`}
						/>
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
		color: var(--danger);
		border-color: var(--danger);
	}
</style>
