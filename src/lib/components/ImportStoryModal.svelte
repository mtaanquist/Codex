<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatNumber } from '$lib/format';

	// The two-step story import (upload, preview the collisions, confirm) in a
	// modal, opened from the library's New menus and from the universe settings
	// page. The form posts to the target universe's settings actions from
	// wherever the modal is mounted, and the chosen file rides both submits, so
	// picking a file is the only upload step the writer sees.

	type ImportNote = { kind: string; name: string; outcome: 'match' | 'create' | 'ambiguous' };
	type ImportPreview = {
		storyTitle: string;
		chapterCount: number;
		sceneCount: number;
		words: number;
		assetCount: number;
		assetsConfigured: boolean;
		titleTaken: boolean;
		notes: ImportNote[];
		problems: string[];
	};
	type ImportResult = {
		slug: string;
		sceneCount: number;
		notesAttached: number;
		entitiesCreated: number;
		problems: string[];
	};

	let {
		universe,
		onClose
	}: {
		// The universe the story lands in; null keeps the modal closed.
		universe: { slug: string; name: string; standalone?: boolean } | null;
		onClose: () => void;
	} = $props();

	const settingsPath = $derived(
		universe ? resolve('/universes/[id]/[[section]]', { id: universe.slug, section: 'export' }) : ''
	);

	const NOTE_OUTCOMES = {
		match: 'matches an existing entry; the note attaches to it.',
		create: 'has no match; a new entry will be created.',
		ambiguous: 'matches more than one entry; the note will be skipped.'
	} as const;

	let formEl = $state<HTMLFormElement>();
	let fileInput = $state<HTMLInputElement>();
	let fileName = $state<string | null>(null);
	let busy = $state(false);
	let busyLabel = $state('');
	let dragOver = $state(false);
	let preview = $state<ImportPreview | null>(null);
	let imported = $state<ImportResult | null>(null);
	let message = $state<string | null>(null);

	// A fresh open starts the flow over. Keyed on the object itself: the
	// callers hold the target in state, so a new reference is a new open.
	let lastUniverse: typeof universe = null;
	$effect(() => {
		if (universe && universe !== lastUniverse) {
			fileName = null;
			preview = null;
			imported = null;
			message = null;
			dragOver = false;
		}
		lastUniverse = universe;
	});

	// Picking or dropping a file previews it at once; the confirm button then
	// posts the same file to the run action.
	function takeFile(file: File | null | undefined) {
		if (!file || !fileInput || busy) return;
		if (!/\.(zip|docx|epub)$/i.test(file.name)) {
			message = 'Choose a Codex export zip, a Word document (.docx), or an EPUB (.epub).';
			return;
		}
		if (fileInput.files?.[0] !== file) {
			const carrier = new DataTransfer();
			carrier.items.add(file);
			fileInput.files = carrier.files;
		}
		fileName = file.name;
		preview = null;
		imported = null;
		message = null;
		formEl?.requestSubmit();
	}

	const submit = () => {
		busy = true;
		busyLabel = preview ? 'Importing...' : 'Reading the file...';
		return async ({ result }: { result: import('@sveltejs/kit').ActionResult }) => {
			busy = false;
			if (result.type === 'success') {
				const data = result.data as
					{ preview?: ImportPreview; imported?: ImportResult } | undefined;
				if (data?.imported) {
					imported = data.imported;
					preview = null;
					// The story list behind the modal picks up the new story.
					await invalidateAll();
				} else if (data?.preview) {
					preview = data.preview;
				}
			} else if (result.type === 'failure') {
				const failure = result.data as { message?: string } | undefined;
				message = failure?.message ?? 'That file could not be read.';
				preview = null;
			} else if (result.type === 'error') {
				message = 'Something went wrong. Try again.';
			}
		};
	};

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragOver = false;
		takeFile(event.dataTransfer?.files?.[0]);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}
</script>

{#if universe}
	<div
		class="modal-backdrop"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}
		onkeydown={onKeydown}
	>
		<div class="modal-panel modal-lg" role="dialog" aria-modal="true" aria-label="Import a story">
			<div class="modal-head">
				<div class="modal-head-main">
					<h2 class="modal-title">Import a story</h2>
					<p class="modal-sub">
						{universe.standalone
							? 'The story comes in as a new standalone story.'
							: `The story comes in as a new story in ${universe.name}.`}
					</p>
				</div>
			</div>

			<div class="modal-body">
				<form
					id="story-import-form"
					bind:this={formEl}
					method="POST"
					action="{settingsPath}?/previewImport"
					enctype="multipart/form-data"
					use:enhance={submit}
				>
					<input
						bind:this={fileInput}
						type="file"
						name="archive"
						accept=".zip,application/zip,.docx,.epub"
						hidden
						onchange={() => takeFile(fileInput?.files?.[0])}
					/>
					{#if !imported}
						<!-- Dragging is a pointer-only extra; the button inside is the
						     keyboard and screen-reader path. -->
						<div
							class="drop-zone"
							role="presentation"
							class:over={dragOver}
							ondragover={(event) => {
								event.preventDefault();
								dragOver = true;
							}}
							ondragleave={() => (dragOver = false)}
							ondrop={onDrop}
						>
							{#if fileName}
								<p class="drop-file">{fileName}</p>
							{/if}
							<button
								type="button"
								class="btn btn-secondary btn-sm"
								disabled={busy}
								onclick={() => fileInput?.click()}
							>
								{fileName ? 'Choose a different file' : 'Choose a file'}
							</button>
							<p class="drop-hint">
								or drop one here: a Codex export zip, a Word document (.docx), or an EPUB (.epub).
								Chapters and scenes are read from the document's own headings and breaks.
							</p>
						</div>
					{/if}
				</form>

				{#if message}
					<p class="import-error" role="alert">{message}</p>
				{/if}
				{#if busy}
					<p class="import-busy" role="status">{busyLabel}</p>
				{/if}

				{#if imported}
					<div class="import-report" role="status">
						<p>
							Imported {imported.sceneCount}
							{imported.sceneCount === 1 ? 'scene' : 'scenes'}{imported.notesAttached > 0
								? ` and ${imported.notesAttached} ${imported.notesAttached === 1 ? 'story note' : 'story notes'}`
								: ''}{imported.entitiesCreated > 0
								? `, creating ${imported.entitiesCreated} ${imported.entitiesCreated === 1 ? 'new entry' : 'new entries'}`
								: ''}.
						</p>
						{#each imported.problems as problem (problem)}
							<p class="import-flag">{problem}</p>
						{/each}
					</div>
				{:else if preview}
					<div class="import-report">
						<p>
							"{preview.storyTitle}": {preview.chapterCount}
							{preview.chapterCount === 1 ? 'chapter' : 'chapters'},
							{preview.sceneCount}
							{preview.sceneCount === 1 ? 'scene' : 'scenes'},
							{formatNumber(preview.words)} words{preview.assetCount > 0
								? `, ${preview.assetCount} ${preview.assetCount === 1 ? 'image' : 'images'}`
								: ''}.
						</p>
						{#if preview.titleTaken}
							<p class="import-flag">
								A story named "{preview.storyTitle}" already exists here; this import creates a
								second one.
							</p>
						{/if}
						{#if preview.assetCount > 0 && !preview.assetsConfigured}
							<p class="import-flag">
								Image storage is not configured, so the bundled images will not be imported.
							</p>
						{/if}
						{#if preview.notes.length > 0}
							<ul class="import-notes">
								{#each preview.notes as note (note.kind + note.name)}
									<li>
										<strong>{note.name}</strong>
										({note.kind === 'lore' ? 'lore entry' : note.kind})
										{NOTE_OUTCOMES[note.outcome]}
									</li>
								{/each}
							</ul>
						{/if}
						{#each preview.problems as problem (problem)}
							<p class="import-flag">{problem}</p>
						{/each}
					</div>
				{/if}
			</div>

			<div class="modal-foot">
				<div class="modal-foot-note"></div>
				{#if imported}
					<button class="btn btn-sm btn-secondary" type="button" onclick={onClose}>Done</button>
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (slug known at runtime) -->
					<a class="btn btn-sm btn-primary" href="/stories/{imported.slug}">Open the story</a>
				{:else}
					<button class="btn btn-sm btn-secondary" type="button" onclick={onClose}>Cancel</button>
					<button
						class="btn btn-sm btn-primary"
						type="submit"
						form="story-import-form"
						formaction="{settingsPath}?/runImport"
						disabled={!preview || busy}
					>
						Import story
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.drop-zone {
		display: grid;
		justify-items: center;
		gap: 8px;
		padding: 22px 16px;
		border: 1.5px dashed var(--border-strong);
		border-radius: var(--radius-md);
		background: var(--bg-inset);
		text-align: center;
	}
	.drop-zone.over {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 8%, var(--bg-inset));
	}
	.drop-file {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.drop-hint {
		margin: 0;
		font-size: var(--text-meta);
		color: var(--text-faint);
		max-width: 36ch;
	}
	.import-error {
		color: var(--danger);
		font-size: var(--text-sm);
		margin: 10px 0 0;
	}
	.import-busy {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 10px 0 0;
	}
	.import-report {
		margin-top: 12px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-inset);
		display: grid;
		gap: 8px;
		justify-items: start;
	}
	.import-report p {
		margin: 0;
		font-size: 13px;
	}
	.import-flag {
		color: var(--text-muted);
	}
	.import-notes {
		margin: 0;
		padding-left: 18px;
		font-size: 13px;
		color: var(--text-muted);
		display: grid;
		gap: 2px;
	}
</style>
