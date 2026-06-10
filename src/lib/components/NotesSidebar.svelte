<script lang="ts">
	import Icon from './Icon.svelte';
	import SidebarSearch from './SidebarSearch.svelte';
	import type { NoteListItem } from '$lib/server/notes';

	// The left pane of a Notes view, shared by the story and universe scopes.
	// Note links keep the current page and swap the ?note= query; the new-note
	// form posts to the createNote action both pages define.
	let {
		notes,
		selectedId,
		notesPath,
		planHref,
		writeHref,
		reviewHref,
		universeNotes = [],
		universeNotesPath,
		form
	}: {
		notes: NoteListItem[];
		selectedId?: string;
		notesPath: string;
		planHref: string;
		// Present at story scope only; the universe Notes view has no Write.
		writeHref?: string;
		// Present at story scope only; the universe Notes view has no Review.
		reviewHref?: string;
		// Universe notes shown read-only at story scope, linking to the universe
		// Notes view to edit. Empty at universe scope.
		universeNotes?: NoteListItem[];
		universeNotesPath?: string;
		form: { scope?: string; message?: string } | null;
	} = $props();

	let query = $state('');
	const q = $derived(query.trim().toLowerCase());
	function matches(note: NoteListItem) {
		return (note.title ?? '').toLowerCase().includes(q);
	}
	const shown = $derived(q === '' ? notes : notes.filter(matches));
	const pinned = $derived(shown.filter((note) => note.pinned));
	const recent = $derived(shown.filter((note) => !note.pinned));
	const shownUniverse = $derived(q === '' ? universeNotes : universeNotes.filter(matches));
</script>

<aside class="pane left">
	<div class="left-head">
		<div class="seg full">
			{#if writeHref}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the path) -->
				<a class="seg-btn" href={writeHref}>Write</a>
			{/if}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the path) -->
			<a class="seg-btn" href={planHref}>Plan</a>
			<button class="seg-btn active" type="button">Notes</button>
			{#if reviewHref}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller resolves the path) -->
				<a class="seg-btn" href={reviewHref}>Review</a>
			{/if}
		</div>
		<SidebarSearch bind:query placeholder="Filter notes..." />
	</div>
	<div class="left-scroll">
		<form method="POST" action="?/createNote" class="note-new">
			<button class="outline-add" type="submit">
				<Icon name="plus" size={13} /> New note
			</button>
		</form>
		{#if form?.scope === 'note' && form.message}
			<p class="note-error" role="alert">{form.message}</p>
		{/if}

		{#if pinned.length > 0}
			<div class="group-label">
				<span class="gl-left">Pinned</span>
				<span class="count">{pinned.length}</span>
			</div>
			{#each pinned as note (note.id)}
				<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
				<a
					class="note-row"
					class:active={note.id === selectedId}
					href={`${notesPath}?note=${note.id}`}
				>
					<Icon name="pin" size={12} />
					<span class="note-name" class:untitled={!note.title}>{note.title || 'Untitled note'}</span
					>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
		{/if}

		{#if recent.length > 0}
			<div class="group-label">
				<span class="gl-left">Notes</span>
				<span class="count">{recent.length}</span>
			</div>
			{#each recent as note (note.id)}
				<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
				<a
					class="note-row"
					class:active={note.id === selectedId}
					href={`${notesPath}?note=${note.id}`}
				>
					<Icon name="note" size={12} />
					<span class="note-name" class:untitled={!note.title}>{note.title || 'Untitled note'}</span
					>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
		{/if}

		{#if shown.length === 0}
			<p class="note-empty">
				{q === '' ? 'No notes here yet.' : 'No notes match your filter.'}
			</p>
		{/if}

		{#if shownUniverse.length > 0 && universeNotesPath}
			<div class="group-label">
				<span class="gl-left">From the universe</span>
				<span class="count">{shownUniverse.length}</span>
			</div>
			{#each shownUniverse as note (note.id)}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (resolved path plus a query string) -->
				<a class="note-row" href={`${universeNotesPath}?note=${note.id}`}>
					<Icon name="universe" size={12} />
					<span class="note-name" class:untitled={!note.title}>{note.title || 'Untitled note'}</span
					>
				</a>
			{/each}
		{/if}
	</div>
</aside>

<style>
	.note-new {
		margin-bottom: 10px;
	}
	.note-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-radius: var(--radius-sm, 6px);
		color: var(--text-muted);
		text-decoration: none;
		font-size: 13.5px;
	}
	.note-row:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.note-row.active {
		background: var(--accent-soft);
		color: var(--text);
	}
	.note-row :global(svg) {
		flex: none;
		color: var(--text-faint);
	}
	.note-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.note-name.untitled {
		color: var(--text-faint);
		font-style: italic;
	}
	.note-error {
		color: var(--danger, #b00020);
		font-size: 12.5px;
		margin: 0 0 8px;
	}
	.note-empty {
		color: var(--text-faint);
		font-size: 13px;
		padding: 4px 8px;
	}
</style>
