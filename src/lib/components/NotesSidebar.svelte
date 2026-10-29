<script lang="ts">
	import { withQuery } from '#lib/href';
	import type { ResolvedPathname } from '$app/types';
	import Icon from './Icon.svelte';
	import SidebarSearch from './SidebarSearch.svelte';
	import type { NoteListItem } from '#lib/wire-types';
	import ModeSwitcher from './ModeSwitcher.svelte';
	import { NOTES_MODE_NOTE, LEFT_PANE_LABEL } from '#lib/chrome';

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
		modeNote,
		universeNotes = [],
		universeNotesPath,
		form
	}: {
		notes: NoteListItem[];
		selectedId?: string;
		notesPath: ResolvedPathname;
		planHref: ResolvedPathname;
		// At universe scope both point at the universe's own story list, which
		// is where you pick the story to write in or review.
		writeHref?: ResolvedPathname;
		reviewHref?: ResolvedPathname;
		// The line under the mode strip, when the strip needs explaining.
		modeNote?: string;
		// Universe notes shown read-only at story scope, linking to the universe
		// Notes view to edit. Empty at universe scope.
		universeNotes?: NoteListItem[];
		universeNotesPath?: ResolvedPathname;
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

<aside class="pane left" aria-label={LEFT_PANE_LABEL}>
	<div class="left-head">
		<!-- The Notes page sits beside the modes, so nothing is lit and one
		     line says how you got here. -->
		<ModeSwitcher
			active={null}
			hrefs={{ write: writeHref, plan: planHref, review: reviewHref }}
			note={modeNote ?? NOTES_MODE_NOTE}
		/>
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
				<a
					class="note-row"
					class:active={note.id === selectedId}
					href={withQuery(notesPath, { note: note.id })}
				>
					<Icon name="pin" size={12} />
					<span class="note-name" class:untitled={!note.title}>{note.title || 'Untitled note'}</span
					>
				</a>
			{/each}
		{/if}

		{#if recent.length > 0}
			<div class="group-label">
				<span class="gl-left">Notes</span>
				<span class="count">{recent.length}</span>
			</div>
			{#each recent as note (note.id)}
				<a
					class="note-row"
					class:active={note.id === selectedId}
					href={withQuery(notesPath, { note: note.id })}
				>
					<Icon name="note" size={12} />
					<span class="note-name" class:untitled={!note.title}>{note.title || 'Untitled note'}</span
					>
				</a>
			{/each}
		{/if}

		{#if shown.length === 0}
			<div class="empty-state tight">
				<p class="empty-state-text">
					{q === '' ? 'No notes here yet.' : 'No notes match your filter.'}
				</p>
			</div>
		{/if}

		{#if shownUniverse.length > 0 && universeNotesPath}
			<div class="group-label">
				<span class="gl-left">From the universe</span>
				<span class="count">{shownUniverse.length}</span>
			</div>
			{#each shownUniverse as note (note.id)}
				<a class="note-row" href={withQuery(universeNotesPath, { note: note.id })}>
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
		color: var(--danger-ink);
		font-size: 12.5px;
		margin: 0 0 8px;
	}
</style>
