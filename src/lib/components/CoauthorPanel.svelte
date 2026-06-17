<script lang="ts">
	import { onMount } from 'svelte';
	import type { EditorView } from '@codemirror/view';
	import Icon from './Icon.svelte';

	// Write with the Assistant: drafts a passage to a brief, which the writer
	// inserts at the cursor, edits, or discards. Nothing is written until Insert.
	// The drafted text sits in an editable field so "edit" is just typing in it
	// before inserting. Opened from the editor toolbar; the parent renders this
	// only while open, so a scene switch unmounts it and aborts any draft.
	let {
		getView,
		storyId,
		sceneId,
		onInserted,
		onClose
	}: {
		getView: () => EditorView | undefined;
		// The owning story and scene; posted so the server can gate and ground.
		storyId: string;
		sceneId: string;
		// Schedules the autosave once inserted text lands in the document.
		onInserted: () => void;
		// Closes the panel (the parent stops rendering it).
		onClose: () => void;
	} = $props();

	// Where the writer is in the prose when the panel opens: the selection if
	// there is one, otherwise the text leading up to the cursor. Shown as a
	// removable chip and sent with the brief, so "continue from here" works.
	type CoauthorReference = { kind: 'selection' | 'cursor'; text: string };
	const COAUTHOR_CURSOR_CHARS = 400;

	let instruction = $state('');
	let busy = $state(false);
	let result = $state('');
	let error = $state('');
	let inputEl = $state<HTMLTextAreaElement>();
	let reference = $state<CoauthorReference | null>(null);
	let pending: AbortController | null = null;

	function captureReference(): CoauthorReference | null {
		const view = getView();
		if (!view) return null;
		const range = view.state.selection.main;
		if (!range.empty) {
			const text = view.state.sliceDoc(range.from, range.to).trim();
			return text ? { kind: 'selection', text } : null;
		}
		const from = Math.max(0, range.head - COAUTHOR_CURSOR_CHARS);
		const text = view.state.sliceDoc(from, range.head);
		// A truncated slice may open mid-word; drop the partial word.
		const trimmed = (from > 0 ? text.replace(/^\S*\s/, '') : text).trim();
		return trimmed ? { kind: 'cursor', text: trimmed } : null;
	}

	// Captured against the selection the panel opened with; the parent only
	// mounts this component when the writer opens it.
	onMount(() => {
		reference = captureReference();
		setTimeout(() => inputEl?.focus(), 0);
		// Abort a draft still streaming when the editor unmounts (scene switch),
		// not only on the explicit close.
		return () => pending?.abort();
	});

	async function generate() {
		const brief = instruction.trim();
		if (!brief || busy) return;
		busy = true;
		error = '';
		pending?.abort();
		const controller = new AbortController();
		pending = controller;
		try {
			const response = await fetch('/api/assistant/coauthor', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ storyId, sceneId, instruction: brief, reference }),
				signal: controller.signal
			});
			if (!response.ok) {
				error = 'The Assistant could not draft that. Check your endpoint in account settings.';
				return;
			}
			const data = (await response.json()) as { text?: string };
			result = (data.text ?? '').trim();
			if (!result) error = 'The Assistant returned nothing to use.';
		} catch {
			if (!controller.signal.aborted) error = 'Something went wrong reaching the Assistant.';
		} finally {
			busy = false;
			pending = null;
		}
	}

	function insert() {
		const view = getView();
		if (!view || !result.trim()) return;
		const head = view.state.selection.main.head;
		view.dispatch({
			changes: { from: head, insert: result },
			selection: { anchor: head + result.length }
		});
		onInserted();
		onClose();
		view.focus();
	}

	function discard() {
		pending?.abort();
		onClose();
	}
</script>

<div class="coauthor-panel">
	<div class="coauthor-head">
		<span class="coauthor-title"><Icon name="sparkles" size={13} /> Write with the Assistant</span>
		<button class="coauthor-x" type="button" title="Close" onclick={discard}>x</button>
	</div>
	{#if reference}
		<div class="coauthor-ref" role="note">
			<span class="coauthor-ref-kind">
				{reference.kind === 'selection' ? 'Pointing at:' : 'Continuing from:'}
			</span>
			<span class="coauthor-ref-text" title={reference.text}>
				{reference.text}
			</span>
			<button
				class="coauthor-ref-x"
				type="button"
				title="Remove the reference"
				aria-label="Remove the reference"
				onclick={() => (reference = null)}
			>
				x
			</button>
		</div>
	{/if}
	<textarea
		bind:this={inputEl}
		class="coauthor-brief"
		rows="2"
		placeholder="What should the Assistant write? e.g. a tense paragraph where Alice spots the toll-keeper lying."
		bind:value={instruction}
		onkeydown={(e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void generate();
			}
		}}
	></textarea>
	{#if error}
		<p class="coauthor-error">{error}</p>
	{/if}
	{#if result}
		<textarea class="coauthor-result" rows="6" bind:value={result}></textarea>
		<div class="coauthor-actions">
			<button class="btn btn-primary" type="button" onclick={insert}> Insert at cursor </button>
			<button class="btn" type="button" onclick={generate} disabled={busy || !instruction.trim()}>
				{busy ? 'Writing...' : 'Try again'}
			</button>
			<button class="btn" type="button" onclick={discard}>Discard</button>
		</div>
	{:else}
		<div class="coauthor-actions">
			<button
				class="btn btn-primary"
				type="button"
				onclick={generate}
				disabled={busy || !instruction.trim()}
			>
				{busy ? 'Writing...' : 'Generate'}
			</button>
			<span class="coauthor-hint">It drafts a passage; you choose whether to insert it.</span>
		</div>
	{/if}
</div>

<style>
	.coauthor-panel {
		border-bottom: 1px solid var(--border);
		background: var(--bg-card);
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.coauthor-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.coauthor-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.coauthor-x {
		border: 0;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
		padding: 2px 6px;
	}
	.coauthor-x:hover {
		color: var(--text);
	}
	.coauthor-ref {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 7px 10px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: 8px;
		background: var(--bg-inset);
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.coauthor-ref-kind {
		flex: none;
		font-weight: 600;
	}
	.coauthor-ref-text {
		flex: 1;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.coauthor-ref-x {
		border: 0;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		font-size: 13px;
		line-height: 1;
		padding: 0 2px;
	}
	.coauthor-ref-x:hover {
		color: var(--text);
	}
	.coauthor-brief,
	.coauthor-result {
		width: 100%;
		resize: vertical;
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		color: var(--text);
		font-family: var(--font-content);
		font-size: 14px;
		line-height: 1.5;
		outline: none;
	}
	.coauthor-brief:focus,
	.coauthor-result:focus {
		border-color: var(--accent-line);
	}
	.coauthor-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.coauthor-hint {
		font-size: 12px;
		color: var(--text-faint);
	}
	.coauthor-error {
		margin: 0;
		font-size: 12.5px;
		color: var(--danger, #c0392b);
	}
</style>
