<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { modal } from '#lib/modal';
	import { post } from '#lib/api';
	import { apiErrorMessage, formatNumber } from '#lib/format';
	import { closeFindReplace, findReplace, type FindReplaceRequest } from '#lib/find-replace.svelte';
	import FormStatus from './FormStatus.svelte';
	import type { StoryFindResult, StoryReplaceResult } from '#lib/wire-types';

	// Find and replace across a chapter or the whole story. Nothing is written
	// until the writer has seen every match and picked which to replace; the
	// page lands pending saves before each step and reloads the editors after.

	let {
		storyId,
		chapters,
		scenes,
		prepare,
		afterReplace,
		onClosed
	}: {
		storyId: string;
		chapters: { id: string; title: string | null }[];
		scenes: { id: string; title: string | null }[];
		// Lands the open editors' pending saves; an error message when it could not.
		prepare: () => Promise<string | null>;
		// Reloads the editors on the replaced text.
		afterReplace: () => Promise<void>;
		// Puts focus back in the writing when what opened the window is gone.
		onClosed: () => void;
	} = $props();

	let find = $state('');
	let replace = $state('');
	let matchCase = $state(true);
	let wholeWord = $state(true);
	let chapterId = $state<string | null>(null);
	// The chapter the modal was opened from, offered beside the whole story.
	let offeredChapterId = $state<string | null>(null);

	let results = $state<StoryFindResult | null>(null);
	let outcome = $state<StoryReplaceResult | null>(null);
	let busy = $state<'search' | 'replace' | null>(null);
	let error = $state<string | null>(null);
	// Picked matches, as "sceneId:start".
	const picked = new SvelteSet<string>();
	// What the listed results were found with; any change hides them.
	let searched = $state('');

	const key = (sceneId: string, start: number) => `${sceneId}:${start}`;
	const searchKey = $derived(JSON.stringify([find, matchCase, wholeWord, chapterId]));

	// A fresh start each time the modal opens; a request that carries the
	// search text (from the editor's find panel) runs it at once.
	$effect(() => {
		if (!findReplace.open) return;
		const request = findReplace.request;
		untrack(() => reset(request));
	});
	function reset(request: FindReplaceRequest) {
		find = request.find ?? '';
		replace = '';
		matchCase = request.matchCase ?? true;
		wholeWord = request.wholeWord ?? true;
		chapterId = request.chapterId;
		offeredChapterId = request.chapterId;
		results = null;
		outcome = null;
		error = null;
		picked.clear();
		if (find !== '') void search();
	}

	// Results found with other settings no longer describe what would change.
	$effect(() => {
		if (results && searchKey !== searched) {
			results = null;
			picked.clear();
		}
	});

	function chapterLabel(id: string | null): string {
		const index = chapters.findIndex((c) => c.id === id);
		if (index === -1) return 'No chapter';
		return chapters[index].title?.trim() || `Chapter ${index + 1}`;
	}
	const sceneTitle = (id: string, fallback: string | null) =>
		scenes.find((s) => s.id === id)?.title?.trim() || fallback?.trim() || 'Untitled scene';

	const matches = (n: number) => `${formatNumber(n)} match${n === 1 ? '' : 'es'}`;
	const sceneCount = (n: number) => `${formatNumber(n)} scene${n === 1 ? '' : 's'}`;

	async function search() {
		if (busy || find === '') return;
		busy = 'search';
		error = null;
		outcome = null;
		// What is searched for is fixed now; typing on while it runs makes the
		// answer stale, and the effect below then hides it.
		const at = searchKey;
		const query: Record<string, string> = {
			q: find,
			case: matchCase ? '1' : '0',
			word: wholeWord ? '1' : '0'
		};
		if (chapterId) query.chapter = chapterId;
		try {
			const ready = await prepare();
			if (ready) {
				error = ready;
				return;
			}
			let response: Response;
			try {
				response = await fetch(
					`/api/stories/${storyId}/find-replace?${new URLSearchParams(query)}`
				);
			} catch {
				error = 'Could not search the story. Try again in a moment.';
				return;
			}
			if (!response.ok) {
				error = await apiErrorMessage(response, 'Could not search the story.');
				return;
			}
			const found = (await response.json()) as StoryFindResult;
			picked.clear();
			for (const scene of found.scenes)
				for (const match of scene.matches) picked.add(key(scene.sceneId, match.start));
			searched = at;
			results = found;
		} finally {
			busy = null;
		}
	}

	function sceneState(sceneId: string, starts: number[]) {
		const count = starts.filter((start) => picked.has(key(sceneId, start))).length;
		return { all: count === starts.length, some: count > 0 && count < starts.length };
	}
	function toggleScene(sceneId: string, starts: number[]) {
		const on = !sceneState(sceneId, starts).all;
		for (const start of starts) {
			if (on) picked.add(key(sceneId, start));
			else picked.delete(key(sceneId, start));
		}
	}
	function toggleMatch(sceneId: string, start: number) {
		const k = key(sceneId, start);
		if (picked.has(k)) picked.delete(k);
		else picked.add(k);
	}
	function pickAll(on: boolean) {
		picked.clear();
		if (!on || !results) return;
		for (const scene of results.scenes)
			for (const match of scene.matches) picked.add(key(scene.sceneId, match.start));
	}

	const pickedCount = $derived(picked.size);

	const changedSkips = $derived(outcome?.skipped.filter((s) => s.reason === 'changed') ?? []);
	const longSkips = $derived(outcome?.skipped.filter((s) => s.reason === 'too_long') ?? []);

	// One live region that stays mounted, so screen readers hear each result.
	const announcement = $derived.by(() => {
		if (outcome) {
			const done =
				outcome.replaced > 0
					? `Replaced ${matches(outcome.replaced)} in ${sceneCount(outcome.scenesChanged)}.`
					: 'Nothing was replaced.';
			return outcome.skipped.length > 0
				? `${done} ${sceneCount(outcome.skipped.length)} left alone.`
				: done;
		}
		if (!results) return '';
		if (results.scenes.length === 0) return 'No matches.';
		return `${matches(results.matchCount)} in ${sceneCount(results.scenes.length)}.`;
	});
	const sameText = $derived(matchCase && replace === find);

	async function apply() {
		if (busy || !results || pickedCount === 0 || sameText) return;
		busy = 'replace';
		error = null;
		// Taken before any wait, so the request matches the list on screen.
		const payload = {
			chapterId,
			find,
			replace,
			matchCase,
			wholeWord,
			scenes: results.scenes
				.map((scene) => ({
					sceneId: scene.sceneId,
					baseHash: scene.baseHash,
					starts: scene.matches
						.map((match) => match.start)
						.filter((start) => picked.has(key(scene.sceneId, start)))
				}))
				.filter((scene) => scene.starts.length > 0)
		};
		let sent = false;
		try {
			const ready = await prepare();
			if (ready) {
				error = ready;
				return;
			}
			sent = true;
			const result = await post<StoryReplaceResult>(
				`/api/stories/${storyId}/find-replace`,
				payload,
				'Could not replace the text.'
			);
			if (!result.ok) {
				error = result.message;
				return;
			}
			outcome = {
				scenesChanged: result.scenesChanged,
				replaced: result.replaced,
				skipped: result.skipped
			};
			results = null;
			picked.clear();
		} finally {
			// Each scene is replaced on its own, so even a failed request may
			// have changed some: always reload the editors once it was sent.
			try {
				if (sent) await afterReplace();
			} finally {
				busy = null;
			}
		}
	}

	function close() {
		if (busy) return;
		closeFindReplace();
		onClosed();
	}

	// Leaving the page while it is open must not reopen it on the next story.
	onDestroy(() => closeFindReplace());
</script>

{#if findReplace.open}
	<div
		class="modal-backdrop top"
		role="presentation"
		onclick={(event) => {
			// Typed terms and ticked matches are not thrown away by a stray click.
			if (event.target === event.currentTarget && (outcome || (find === '' && replace === '')))
				close();
		}}
	>
		<div
			class="modal-panel modal-lg"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fr-title"
			use:modal={{ close, initialFocus: findReplace.request.find ? '#fr-replace' : '#fr-find' }}
		>
			<div class="modal-head">
				<div class="modal-head-main">
					<h2 class="modal-title" id="fr-title">Find and replace</h2>
					<p class="modal-sub">
						{chapterId ? `In ${chapterLabel(chapterId)}` : 'In the whole story'}
					</p>
				</div>
			</div>

			<div class="modal-body">
				<form
					class="fr-form"
					onsubmit={(event) => {
						event.preventDefault();
						void search();
					}}
				>
					<div class="field-grid">
						<div class="field">
							<label for="fr-find">Find</label>
							<input
								id="fr-find"
								class="input"
								type="text"
								autocomplete="off"
								spellcheck="false"
								maxlength={500}
								bind:value={find}
							/>
						</div>
						<div class="field">
							<label for="fr-replace">Replace with</label>
							<input
								id="fr-replace"
								class="input"
								type="text"
								autocomplete="off"
								spellcheck="false"
								maxlength={500}
								bind:value={replace}
							/>
						</div>
					</div>
					<div class="fr-options">
						{#if offeredChapterId}
							<div class="seg" role="group" aria-label="Search in">
								<button
									class="seg-btn"
									class:active={chapterId === offeredChapterId}
									type="button"
									aria-pressed={chapterId === offeredChapterId}
									onclick={() => (chapterId = offeredChapterId)}
								>
									This chapter
								</button>
								<button
									class="seg-btn"
									class:active={chapterId === null}
									type="button"
									aria-pressed={chapterId === null}
									onclick={() => (chapterId = null)}
								>
									Whole story
								</button>
							</div>
						{/if}
						<label class="choice"
							><input type="checkbox" bind:checked={matchCase} /> Match case</label
						>
						<label class="choice"
							><input type="checkbox" bind:checked={wholeWord} /> Whole words</label
						>
						<button
							class="btn btn-sm btn-secondary fr-find"
							type="submit"
							disabled={busy !== null || !find}
						>
							{busy === 'search' ? 'Searching...' : 'Find'}
						</button>
					</div>
				</form>

				<FormStatus {error} block />
				<p class="visually-hidden" role="status">{announcement}</p>

				{#if outcome}
					<div class="fr-outcome">
						{#if outcome.replaced > 0}
							<p>
								Replaced {matches(outcome.replaced)} in {sceneCount(outcome.scenesChanged)}. To
								undo, restore an earlier version of a scene from its History tab.
							</p>
						{:else}
							<p>Nothing was replaced.</p>
						{/if}
						{#if changedSkips.length > 0}
							<p>
								{changedSkips.length === 1 ? 'This scene was' : 'These scenes were'} left alone because
								{changedSkips.length === 1 ? 'it' : 'they'} changed after you searched. Select Find to
								search again.
							</p>
							<ul class="fr-skipped">
								{#each changedSkips as scene (scene.sceneId)}
									<li>{sceneTitle(scene.sceneId, scene.title)}</li>
								{/each}
							</ul>
						{/if}
						{#if longSkips.length > 0}
							<p>
								{longSkips.length === 1 ? 'This scene was' : 'These scenes were'} left alone because the
								change would make {longSkips.length === 1 ? 'it' : 'them'} too long to save. Split
								{longSkips.length === 1 ? 'it' : 'them'} first.
							</p>
							<ul class="fr-skipped">
								{#each longSkips as scene (scene.sceneId)}
									<li>{sceneTitle(scene.sceneId, scene.title)}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{:else if results}
					{#if results.scenes.length === 0}
						<p class="fr-summary">No matches.</p>
					{:else}
						<div class="fr-summary-row">
							<p class="fr-summary">
								{matches(results.matchCount)} in {sceneCount(results.scenes.length)}.
								{#if results.truncated}
									Only the first {matches(results.scenes.reduce((n, s) => n + s.matches.length, 0))} are
									listed; replace these, then search again for the rest.
								{/if}
							</p>
							<button class="btn btn-sm btn-ghost" type="button" onclick={() => pickAll(true)}
								>Select all</button
							>
							<button class="btn btn-sm btn-ghost" type="button" onclick={() => pickAll(false)}
								>Select none</button
							>
						</div>
						<div class="fr-results">
							{#each results.scenes as scene (scene.sceneId)}
								{@const starts = scene.matches.map((m) => m.start)}
								{@const state = sceneState(scene.sceneId, starts)}
								<section class="fr-scene">
									<label class="choice fr-scene-head">
										<input
											type="checkbox"
											checked={state.all}
											indeterminate={state.some}
											onchange={() => toggleScene(scene.sceneId, starts)}
										/>
										<span class="fr-scene-title">{sceneTitle(scene.sceneId, scene.title)}</span>
										<span class="fr-scene-meta">
											{#if !chapterId}{chapterLabel(scene.chapterId)},
											{/if}{matches(scene.matches.length)}
										</span>
									</label>
									<ul class="fr-matches">
										{#each scene.matches as match (match.start)}
											<li>
												<label class="choice fr-match">
													<input
														type="checkbox"
														aria-label={`Replace in: ${match.before}${match.text}${match.after}`}
														checked={picked.has(key(scene.sceneId, match.start))}
														onchange={() => toggleMatch(scene.sceneId, match.start)}
													/>
													<span class="fr-snippet"
														>{match.before}<del>{match.text}</del>{#if replace !== ''}<ins
																>{replace}</ins
															>{/if}{match.after}</span
													>
												</label>
											</li>
										{/each}
									</ul>
								</section>
							{/each}
						</div>
					{/if}
				{/if}
			</div>

			<div class="modal-foot">
				<div class="modal-foot-note">
					{#if results && results.scenes.length > 0}
						{pickedCount === 0 ? 'Nothing selected' : `${matches(pickedCount)} selected`}
					{/if}
				</div>
				{#if outcome}
					<button class="btn btn-sm btn-primary" type="button" onclick={close}>Done</button>
				{:else}
					<button
						class="btn btn-sm btn-secondary"
						type="button"
						onclick={close}
						disabled={busy !== null}>Cancel</button
					>
					<button
						class="btn btn-sm btn-primary"
						type="button"
						onclick={apply}
						disabled={busy !== null || !results || pickedCount === 0 || sameText}
					>
						{busy === 'replace'
							? 'Replacing...'
							: `Replace ${pickedCount > 0 ? matches(pickedCount) : ''}`.trim()}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.fr-form .field-grid .field {
		margin-bottom: 10px;
	}
	.fr-options {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 16px;
	}
	.fr-find {
		margin-left: auto;
	}
	.fr-summary-row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 14px;
	}
	.fr-summary {
		flex: 1;
		margin: 14px 0 0;
		font-size: var(--text-meta);
		color: var(--text-muted);
	}
	.fr-summary-row .fr-summary {
		margin: 0;
	}
	.fr-results {
		margin-top: 8px;
		max-height: 46vh;
		overflow-y: auto;
		border-top: 1px solid var(--border);
	}
	.fr-scene {
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.fr-scene-head {
		font-weight: 600;
	}
	.fr-scene-meta {
		margin-left: auto;
		font-weight: 400;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.fr-matches {
		list-style: none;
		margin: 0;
		padding: 0 0 0 22px;
	}
	.fr-match {
		align-items: flex-start;
		padding: 3px 0;
	}
	.fr-snippet {
		font-family: var(--font-content);
		font-size: var(--text-meta);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.fr-snippet del {
		color: var(--danger-ink);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
	}
	.fr-snippet ins {
		margin-left: 2px;
		text-decoration: none;
		color: var(--status-final-ink);
		background: color-mix(in srgb, var(--status-final) 12%, transparent);
	}
	.fr-outcome {
		margin-top: 14px;
		font-size: var(--text-base);
	}
	.fr-outcome p {
		margin: 0 0 8px;
	}
	.fr-skipped {
		margin: 0;
		padding-left: 18px;
		font-size: var(--text-meta);
		color: var(--text-muted);
	}
</style>
