<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView } from '@codemirror/view';
	import { Compartment, EditorState } from '@codemirror/state';
	import Icon from './Icon.svelte';
	import EditorToolbar from './EditorToolbar.svelte';
	import {
		commandMarkerExtensions,
		nonPrintingFor,
		proseExtensions,
		type MarkVisibility
	} from '$lib/editor';
	import { mentionExtensions, type MentionEntity } from '$lib/editor-mentions';
	import {
		buildReviewMarks,
		reviewMarksExtension,
		setReviewMarks,
		type ReviewMarksHandle
	} from '$lib/editor-review-marks';
	import {
		authorColor,
		suggestionAuthor,
		threadAuthor,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '$lib/review-ui';

	let {
		scene,
		chapterTitle,
		threads,
		suggestions,
		filter,
		focusedId,
		setFocused,
		canSuggest,
		entities,
		mentionMembers,
		mentionPins,
		entityHref,
		nonPrintingMarks = 'hidden',
		commandMarkers = 'shown',
		onStartComment,
		onStartSuggest
	}: {
		scene: { id: string; title: string | null; bodyMd: string };
		chapterTitle: string;
		threads: ReviewThread[];
		suggestions: ReviewSuggestion[];
		filter: ReviewFilter;
		focusedId: string | null;
		setFocused: (id: string | null) => void;
		canSuggest: boolean;
		// The editor view toggles, shared with the Write editor and persisted per
		// user; mirrored locally so a toggle takes effect at once.
		nonPrintingMarks?: MarkVisibility;
		commandMarkers?: MarkVisibility;
		entities: MentionEntity[];
		mentionMembers: string[];
		mentionPins: Record<string, string>;
		// Where a mention's hover card points for full details; null for reviewers.
		entityHref: ((entity: MentionEntity) => string) | null;
		onStartComment: (sel: { start: number; end: number; text: string }) => void;
		onStartSuggest: (sel: { start: number; end: number; text: string }) => void;
	} = $props();

	// Autosave fires on a pause, not every keystroke; revisions coalesce a burst.
	const SAVE_DEBOUNCE_MS = 1500;

	let editorEl = $state<HTMLDivElement>();
	let docEl = $state<HTMLElement>();
	let scrollEl = $state<HTMLElement>();
	let view: EditorView | undefined;
	let handle: ReviewMarksHandle | undefined;

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	// Chained so a slow earlier save can never land after a newer one.
	let saveChain: Promise<void> = Promise.resolve();
	// The last body the editor took from the server, so an external change (an
	// accepted suggestion rewrites the prose) is told apart from the author's
	// own typing. Seeded from the initial prop on purpose.
	// svelte-ignore state_referenced_locally
	let appliedBody = scene.bodyMd;

	// View toggles, mirrored locally and persisted for the user the same way the
	// Write editor does, so the choice carries between the two.
	// svelte-ignore state_referenced_locally
	let nonPrinting = $state<MarkVisibility>(nonPrintingMarks);
	// svelte-ignore state_referenced_locally
	let commands = $state<MarkVisibility>(commandMarkers);
	const nonPrintingCompartment = new Compartment();
	const alignmentCompartment = new Compartment();

	function persistEditorView(patch: { nonPrintingMarks?: string; commandMarkers?: string }) {
		void fetch('/api/editor-view', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch)
		}).catch(() => {});
	}
	function toggleNonPrinting() {
		nonPrinting = nonPrinting === 'shown' ? 'hidden' : 'shown';
		persistEditorView({ nonPrintingMarks: nonPrinting });
	}
	function toggleCommandMarkers() {
		commands = commands === 'shown' ? 'hidden' : 'shown';
		persistEditorView({ commandMarkers: commands });
	}

	async function save() {
		if (!view) return;
		dirty = false;
		try {
			const body = view.state.doc.toString();
			const response = await fetch(`/api/scenes/${scene.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				// No markers field: the review centre does not load scene markers,
				// and the endpoint leaves the stored anchors untouched when it is
				// absent.
				body: JSON.stringify({ title: scene.title, bodyMd: body })
			});
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
			// What we just persisted is now the server's truth, so the external
			// sync below does not mistake it for someone else's change.
			appliedBody = body;
		} catch {
			dirty = true;
		}
	}

	function enqueueSave() {
		saveChain = saveChain.then(save);
	}

	function scheduleSave() {
		dirty = true;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(enqueueSave, SAVE_DEBOUNCE_MS);
	}

	async function flushSave(): Promise<void> {
		clearTimeout(saveTimer);
		if (dirty) enqueueSave();
		await saveChain;
	}

	// A reload or tab close inside the debounce window would drop the tail edit:
	// teardown does not run on unload, so flush with a request that outlives the
	// page.
	function flushOnPageHide() {
		if (!dirty || !view) return;
		clearTimeout(saveTimer);
		dirty = false;
		void fetch(`/api/scenes/${scene.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			keepalive: true,
			body: JSON.stringify({ title: scene.title, bodyMd: view.state.doc.toString() })
		}).catch(() => {
			dirty = true;
		});
	}

	function rebuildMarks() {
		if (!view) return;
		view.dispatch({
			effects: setReviewMarks.of(
				buildReviewMarks(threads, suggestions, filter, view.state.doc.length, focusedId)
			)
		});
	}

	// ---- margin rail + floating selection toolbar, positioned from CM ----
	type Marker = { id: string; kind: 'comment' | 'suggest'; color: string; top: number };
	let markers = $state<Marker[]>([]);
	let sel = $state<{ left: number; top: number; start: number; end: number; text: string } | null>(
		null
	);

	function recomputeGeometry() {
		if (!view || !docEl) return;
		const docRect = docEl.getBoundingClientRect();
		const raw: Marker[] = [];

		for (const thread of threads) {
			if (thread.resolvedAt !== null) continue;
			if (filter !== 'all' && filter !== 'comments') continue;
			const a = handle?.anchorOf(view, thread.id);
			if (!a) continue;
			const c = view.coordsAtPos(a.start);
			if (!c) continue;
			raw.push({
				id: thread.id,
				kind: 'comment',
				color: authorColor(threadAuthor(thread)),
				top: c.top - docRect.top
			});
		}
		for (const suggestion of suggestions) {
			if (suggestion.status !== 'pending') continue;
			if (filter !== 'all' && filter !== 'suggestions') continue;
			const a = handle?.anchorOf(view, suggestion.id);
			if (!a) continue;
			const c = view.coordsAtPos(a.start);
			if (!c) continue;
			raw.push({
				id: suggestion.id,
				kind: 'suggest',
				color: authorColor(suggestionAuthor(suggestion)),
				top: c.top - docRect.top
			});
		}
		raw.sort((x, y) => x.top - y.top);
		// Nudge stacked markers apart so each stays clickable.
		let last = -999;
		for (const m of raw) {
			if (m.top < last + 32) m.top = last + 32;
			last = m.top;
		}
		markers = raw;

		const range = view.state.selection.main;
		if (range.empty) {
			sel = null;
			return;
		}
		const to = view.coordsAtPos(range.to);
		if (!to) {
			sel = null;
			return;
		}
		sel = {
			left: to.right - docRect.left,
			top: to.top - docRect.top,
			start: range.from,
			end: range.to,
			text: view.state.sliceDoc(range.from, range.to)
		};
	}

	// A new comment or edit anchors against the saved text, so flush first; the
	// offsets we captured then line up with the body the server holds.
	async function startComment() {
		if (!sel) return;
		const captured = sel;
		sel = null;
		window.getSelection()?.removeAllRanges();
		await flushSave();
		onStartComment({ start: captured.start, end: captured.end, text: captured.text });
	}
	async function startSuggest() {
		if (!sel) return;
		const captured = sel;
		sel = null;
		window.getSelection()?.removeAllRanges();
		await flushSave();
		onStartSuggest({ start: captured.start, end: captured.end, text: captured.text });
	}

	// Rebuild marks (with the focus highlight baked in) on every data, filter, or
	// focus change, and sync the doc when the prose changed under us (an accept
	// rewrote it server-side). Local unsaved edits win, so "build on an accepted
	// suggestion" works: accept first, the reload brings the new prose, then edit.
	$effect(() => {
		const incoming = scene.bodyMd;
		// Track the inputs so the effect reruns when they change.
		void threads;
		void suggestions;
		void filter;
		void focusedId;
		if (!view) return;
		if (incoming !== appliedBody) {
			if (!dirty && view.state.doc.toString() !== incoming) {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: incoming }
				});
			}
			appliedBody = incoming;
		}
		rebuildMarks();
		recomputeGeometry();
	});

	// Flip the view toggles at runtime by reconfiguring their compartments.
	$effect(() => {
		const extension = nonPrintingFor(nonPrinting);
		if (!view) return;
		view.dispatch({ effects: nonPrintingCompartment.reconfigure(extension) });
	});
	$effect(() => {
		const extension = commandMarkerExtensions(commands);
		if (!view) return;
		view.dispatch({ effects: alignmentCompartment.reconfigure(extension) });
	});

	// Bring the focused passage into view when focus arrives from the panel/nav.
	// A whole-scene comment has no anchor, so take the reader to the scene start.
	$effect(() => {
		const id = focusedId;
		if (!id || !view) return;
		const whole =
			threads.some((t) => t.id === id && !t.anchor) ||
			suggestions.some((s) => s.id === id && !s.anchor);
		if (whole) {
			view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });
			return;
		}
		const a = handle?.anchorOf(view, id);
		if (a) view.dispatch({ effects: EditorView.scrollIntoView(a.start, { y: 'center' }) });
	});

	onMount(() => {
		handle = reviewMarksExtension({
			onFocusMark: setFocused,
			onGeometry: recomputeGeometry
		});
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: scene.bodyMd,
				extensions: [
					...proseExtensions({
						placeholder: 'This scene has not been drafted yet.',
						onDocChanged: () => {
							scheduleSave();
							recomputeGeometry();
						},
						editingMode: 'markdown',
						nonPrintingMarks: nonPrinting,
						commandMarkers: commands,
						compartments: {
							nonPrinting: nonPrintingCompartment,
							alignment: alignmentCompartment
						}
					}),
					mentionExtensions(entities, {
						storyMembers: mentionMembers,
						pins: mentionPins,
						// The hover card's full-details link resolves the entity back to its
						// page; reviewers get no link.
						entityHref: entityHref
							? (ref) => {
									const full = entities.find((e) => e.id === ref.id);
									return full ? entityHref(full) : '#';
								}
							: undefined
					}),
					handle.extension
				]
			})
		});
		rebuildMarks();
		recomputeGeometry();
		return () => {
			clearTimeout(saveTimer);
			if (dirty) enqueueSave();
			void saveChain.then(() => {
				view?.destroy();
				view = undefined;
			});
		};
	});

	const openComments = $derived(threads.filter((t) => t.resolvedAt === null).length);
	const openSugg = $derived(suggestions.filter((s) => s.status === 'pending').length);
</script>

<div class="md-editor review-editor">
	<EditorToolbar
		view={() => view}
		modeLabel="Editing - select text to comment"
		nonPrintingActive={nonPrinting === 'shown'}
		onToggleNonPrinting={toggleNonPrinting}
		commandMarkersActive={commands === 'shown'}
		onToggleCommandMarkers={toggleCommandMarkers}
	/>

	<div class="editor-scroll review-scroll" bind:this={scrollEl}>
		<div class="review-doc" bind:this={docEl}>
			<div class="review-head">
				<div class="review-kicker">{chapterTitle} - review</div>
				<h1 class="review-title">{scene.title ?? 'Untitled scene'}</h1>
				<div class="review-subline">
					{#if openComments + openSugg === 0}
						No open review activity in this scene.
					{:else}
						{#if openComments > 0}
							<span class="rv-sub-chip">
								<Icon name="comment" size={13} />
								{openComments}
								{openComments === 1 ? 'comment' : 'comments'}
							</span>
						{/if}
						{#if openSugg > 0}
							<span class="rv-sub-chip">
								<Icon name="suggest" size={13} />
								{openSugg}
								{openSugg === 1 ? 'suggestion' : 'suggestions'}
							</span>
						{/if}
					{/if}
				</div>
			</div>

			<div class="review-edit editor-cm" bind:this={editorEl}></div>

			<div class="review-rail" aria-hidden="true">
				{#each markers as marker (marker.id)}
					<button
						class="rv-marker"
						class:is-focused={focusedId === marker.id}
						style="top: {marker.top}px; --auth: {marker.color};"
						type="button"
						onclick={() => setFocused(marker.id)}
						title="Jump to this note"
					>
						<Icon name={marker.kind === 'comment' ? 'comment' : 'suggest'} size={13} />
					</button>
				{/each}
			</div>

			{#if sel}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="rv-seltool"
					style="left: {sel.left}px; top: {sel.top}px;"
					onmousedown={(e) => e.preventDefault()}
				>
					<button type="button" onclick={startComment}>
						<Icon name="comment-plus" size={15} /> Comment
					</button>
					{#if canSuggest}
						<span class="rv-seltool-sep"></span>
						<button type="button" onclick={startSuggest}>
							<Icon name="suggest" size={15} /> Suggest edit
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<svelte:window onpagehide={flushOnPageHide} />
