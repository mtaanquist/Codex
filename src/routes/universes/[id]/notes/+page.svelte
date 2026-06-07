<script lang="ts">
	import { resolve } from '$app/paths';
	import NotesSidebar from '$lib/components/NotesSidebar.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
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
</script>

<svelte:head>
	<title>{data.universe.name} - Notes - Codex</title>
</svelte:head>

<div class="app">
	<TopBar
		universe={{ slug: data.universe.slug, name: data.universe.name }}
		{saveStatus}
		help={{ topic: 'planning', label: 'notes' }}
	/>
	<div class="body">
		<NotesSidebar
			notes={data.universeNotes}
			{selectedId}
			{notesPath}
			planHref={resolve('/universes/[id]/plan', { id: data.universe.slug })}
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
				<div class="empty">
					<p>Select a note, or make a new one in the sidebar.</p>
				</div>
			{/if}
		</main>
		<aside class="pane right">
			<div class="right-head">
				<div class="rtabs"><span class="rtab active">History</span></div>
			</div>
			{#if data.selected}
				<RevisionHistory
					entityType="note"
					entityId={data.selected.id}
					revisions={data.revisionRows}
					previewId={data.revisionPreview?.id}
					previewHref={(revisionId) => `${itemHref}&revision=${revisionId}`}
				/>
			{:else}
				<div class="right-scroll">
					<div class="empty">Select a note to see its history.</div>
				</div>
			{/if}
		</aside>
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
