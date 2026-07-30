<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { modLabel } from '$lib/keys';
	import { quickNote, openQuickNote, closeQuickNote } from '$lib/quick-note.svelte';

	// The quick-note jot: a small card floating over the editor, opened with
	// Ctrl/Cmd+Alt+N or from the command palette, that saves a thought to the
	// story's notes (attached to the open scene when there is one) and hands
	// focus straight back. The draft survives closing the card unsaved; only
	// saving or clearing empties it.

	let {
		storyId,
		sceneId = null
	}: {
		storyId: string;
		// The open scene; a note made while one is open attaches to it.
		sceneId?: string | null;
	} = $props();

	// The platform's command modifier for the hint line; SSR says Ctrl.
	let mod = $state<'Cmd' | 'Ctrl'>('Ctrl');
	onMount(() => (mod = modLabel()));

	let text = $state('');
	let saving = $state(false);
	let message = $state<string | null>(null);
	let savedHref = $state<string | null>(null);
	let textarea = $state<HTMLTextAreaElement>();
	let restoreTo: HTMLElement | null = null;

	// Focus the jot on open, and hand focus back on close.
	$effect(() => {
		if (quickNote.open) {
			restoreTo = document.activeElement as HTMLElement | null;
			savedHref = null;
			message = null;
			textarea?.focus();
		}
	});

	function close() {
		closeQuickNote();
		restoreTo?.focus?.();
		restoreTo = null;
	}

	// The first line names the note; the rest is its body.
	function splitDraft(draft: string): { title: string; bodyMd: string } {
		const lines = draft.split('\n');
		const title = (lines[0] ?? '').trim().slice(0, 120);
		const bodyMd = lines.slice(1).join('\n').trim();
		return { title, bodyMd: bodyMd || title };
	}

	async function save() {
		const draft = text.trim();
		if (!draft || saving) return;
		saving = true;
		message = null;
		try {
			const { title, bodyMd } = splitDraft(draft);
			const response = await fetch('/api/notes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ storyId, sceneId, title, bodyMd })
			});
			if (!response.ok) {
				message = 'Could not save the note. Try again.';
				return;
			}
			const data = (await response.json()) as { href: string };
			text = '';
			savedHref = data.href;
			// The Notes panel behind the card picks up the new note.
			await invalidateAll();
			close();
		} finally {
			saving = false;
		}
	}

	function onWindowKeydown(event: KeyboardEvent) {
		// Mod+Alt+N; code, not key, because Alt changes the typed character on
		// some layouts.
		if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyN') {
			event.preventDefault();
			if (quickNote.open) close();
			else openQuickNote();
		}
	}

	function onCardKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void save();
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if quickNote.open}
	<section class="quick-note" aria-label="Quick note">
		<header class="qn-head">
			<span class="qn-title">Quick note</span>
			<span class="qn-scope">{sceneId ? 'on this scene' : 'on this story'}</span>
		</header>
		<textarea
			bind:this={textarea}
			bind:value={text}
			class="qn-text"
			rows="4"
			placeholder="Jot it down; the first line becomes the title."
			onkeydown={onCardKeydown}></textarea>
		{#if message}
			<p class="qn-error" role="alert">{message}</p>
		{/if}
		<footer class="qn-foot">
			<span class="qn-hint">{mod}+Enter saves, Esc closes.</span>
			<button class="btn btn-sm btn-ghost" type="button" onclick={close}>Close</button>
			<button
				class="btn btn-sm btn-primary"
				type="button"
				disabled={saving || !text.trim()}
				onclick={save}
			>
				Save note
			</button>
		</footer>
	</section>
{:else if savedHref}
	<div class="quick-note qn-saved" role="status">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (href from the server) -->
		Saved. <a href={savedHref}>Open the note</a>
		<button class="qn-dismiss" type="button" aria-label="Dismiss" onclick={() => (savedHref = null)}
			>&times;</button
		>
	</div>
{/if}

<style>
	.quick-note {
		position: fixed;
		right: 18px;
		bottom: 18px;
		z-index: 90;
		width: min(340px, calc(100vw - 36px));
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow);
	}
	.qn-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.qn-title {
		font-size: var(--text-sm);
		font-weight: 650;
	}
	.qn-scope {
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.qn-text {
		width: 100%;
		resize: vertical;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		font-family: var(--font-content);
		font-size: var(--text-base);
		line-height: 1.5;
		padding: 8px 10px;
	}
	.qn-text:focus {
		outline: 2px solid color-mix(in oklab, var(--accent) 55%, transparent);
		outline-offset: 1px;
	}
	.qn-error {
		margin: 0;
		font-size: var(--text-meta);
		color: var(--danger);
	}
	.qn-foot {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.qn-hint {
		flex: 1;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.qn-saved {
		flex-direction: row;
		align-items: center;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.qn-saved a {
		color: var(--accent);
	}
	.qn-dismiss {
		margin-left: auto;
		border: 0;
		background: none;
		color: var(--text-faint);
		font-size: 15px;
		cursor: pointer;
		padding: 0 2px;
	}
</style>
