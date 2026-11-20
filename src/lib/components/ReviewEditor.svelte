<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView } from '@codemirror/view';
	import { Compartment, EditorState } from '@codemirror/state';
	import ReviewSceneHead from './ReviewSceneHead.svelte';
	import ReviewMarginRail from './ReviewMarginRail.svelte';
	import ReviewSelectionToolbar from './ReviewSelectionToolbar.svelte';
	import EditorToolbar from './EditorToolbar.svelte';
	import SceneConflictBanner from './SceneConflictBanner.svelte';
	import type { ViewItem } from './ViewMenu.svelte';
	import {
		commandMarkerExtensions,
		nonPrintingFor,
		proseExtensions,
		type MarkVisibility
	} from '#lib/editor';
	import { mentionExtensions, type MentionEntity } from '#lib/editor-mentions';
	import { landsWhilePaused, pausedExtension } from '#lib/editor-paused';
	import {
		buildReviewMarks,
		removeReviewMarks,
		reviewMarksExtension,
		setReviewMarks,
		type ReviewMarksHandle
	} from '#lib/editor-review-marks';
	import { createAutosave, type SaveStatus } from '#lib/autosave';
	import { createSceneSaver, type SceneConflict } from '#lib/scene-saver';
	import {
		toggleCommandMarkers as toggleCommandMarkersView,
		toggleNonPrintingMarks
	} from '#lib/editor-view';
	import {
		nudgeMarkers,
		isWholeSceneNote,
		authorColor,
		suggestionAuthor,
		threadAuthor,
		type RailMarker,
		type ReviewFilter,
		type ReviewSuggestion,
		type ReviewThread
	} from '#lib/review-ui';

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
		editorStyle,
		viewMenu,
		onStartComment,
		onStartSuggest,
		onStatus = () => {},
		paused = false
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
		// The writer's editor-appearance CSS variables (font, line spacing,
		// default alignment), so the review centre matches the Write editor.
		// Absent for guest reviewers, who keep the default typography.
		editorStyle?: string;
		// The View dropdown (Edit, Preview, Focus, Print), the same as the Write
		// toolbar.
		viewMenu?: ViewItem[];
		entities: MentionEntity[];
		mentionMembers: string[];
		mentionPins: Record<string, string>;
		// Where a mention's hover card points for full details; null for reviewers.
		entityHref: ((entity: MentionEntity) => string) | null;
		onStartComment: (sel: { start: number; end: number; text: string }) => void;
		onStartSuggest: (sel: { start: number; end: number; text: string }) => void;
		// Save feedback for the app bar, same contract as SceneEditor's.
		onStatus?: (status: SaveStatus) => void;
		// Set while the page saves and then replaces the scene (a merge or
		// duplicate); the editor takes no typing until it is done.
		paused?: boolean;
	} = $props();

	// Autosave fires on a pause, not every keystroke; revisions coalesce a burst.
	const SAVE_DEBOUNCE_MS = 1500;

	let editorEl = $state<HTMLDivElement>();
	let docEl = $state<HTMLElement>();
	let view: EditorView | undefined;
	let handle: ReviewMarksHandle | undefined;

	// The last body the editor took from the server, so an external change (an
	// accepted suggestion rewrites the prose) is told apart from the author's
	// own typing. Seeded from the initial prop on purpose.
	// svelte-ignore state_referenced_locally
	let appliedBody = scene.bodyMd;

	// Set when a save was refused because the scene changed elsewhere.
	let conflict = $state<SceneConflict | null>(null);
	// svelte-ignore state_referenced_locally
	const saver = createSceneSaver(scene.id, scene.bodyMd, (next) => (conflict = next));
	const autosave = createAutosave({
		debounceMs: SAVE_DEBOUNCE_MS,
		onStatus: (status) => onStatus(status),
		save: async ({ keepalive }) => {
			if (!view) return;
			const body = view.state.doc.toString();
			// No markers field: the review centre does not load scene markers,
			// and the endpoint leaves the stored anchors untouched when it is
			// absent.
			await saver.save({ keepalive, title: scene.title, bodyMd: body });
			// What we just persisted is now the server's truth, so the external
			// sync below does not mistake it for someone else's change.
			appliedBody = body;
		}
	});

	// Swap in the newer text; the edits made here since are dropped.
	function loadNewer() {
		if (!view || !conflict || paused) return;
		const newer = conflict.bodyMd;
		saver.adopt(newer);
		appliedBody = newer;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: newer } });
		void autosave.flush();
	}

	function keepMine() {
		if (!conflict || paused) return;
		saver.keepMine(conflict.bodyMd);
		void autosave.flush();
	}
	// True while the doc is being replaced with the server's text.
	let syncingFromServer = false;
	const scheduleSave = () => {
		if (!syncingFromServer) autosave.schedule();
	};

	// Same contract as SceneEditor's, so the page can land pending saves before
	// an action that reads the stored text.
	export async function flushSave(): Promise<void> {
		await autosave.flush();
	}
	export function isDirty(): boolean {
		return autosave.hasUnsaved();
	}

	// View toggles, mirrored locally and persisted for the user the same way the
	// Write editor does, so the choice carries between the two.
	// svelte-ignore state_referenced_locally
	let nonPrinting = $state<MarkVisibility>(nonPrintingMarks);
	// svelte-ignore state_referenced_locally
	let commands = $state<MarkVisibility>(commandMarkers);
	const nonPrintingCompartment = new Compartment();
	const alignmentCompartment = new Compartment();
	const pausedCompartment = new Compartment();

	function toggleNonPrinting() {
		nonPrinting = toggleNonPrintingMarks(nonPrinting);
	}
	function toggleCommandMarkers() {
		commands = toggleCommandMarkersView(commands);
	}

	// Folds suggestions the server just accepted into the live document, at
	// their anchors as mapped through any typing the author has done meanwhile.
	// Without this the editor only learns of an accept when the page data
	// reloads, and an autosave of the still-old document in that window (or of
	// unsaved edits from before the accept) would silently overwrite the
	// accepted text. Applied one at a time in the server's order, so a later
	// anchor maps through an earlier application the same way it did there.
	// accepted is the scene text the server saved with the change, and the
	// fingerprint of the text it was applied to. When that was the text this
	// editor last saved and the same change lands here, the next save builds on
	// the new text; otherwise the save check reports the difference.
	// replacements carries the author's own wording for an edit accepted with
	// changes (the guided pass's Edit), keyed by suggestion id.
	export function applyAccepted(
		ids: string[],
		accepted: { bodyMd: string; baseHash: string } | null = null,
		replacements: Record<string, string> = {}
	) {
		if (!view || !handle) return;
		// A change to another scene (accepted from a pass or a card while this
		// scene is open) is not this editor's: its text must never land here.
		if (ids.some((id) => !suggestions.some((s) => s.id === id))) return;
		// Nothing typed here is waiting to be saved, so the editor showed the
		// text the server changed.
		const wasClean = !autosave.hasUnsaved() && !conflict;
		let applied = true;
		for (const id of ids) {
			const suggestion = suggestions.find((s) => s.id === id);
			const mark = suggestion?.status === 'pending' ? handle.anchorOf(view, id) : null;
			if (!suggestion || !mark) {
				applied = false;
				continue;
			}
			// The mark leaves out the white space at the edges of the range; the
			// server replaced the whole range, so widen back to it. When the text
			// there is not what the suggestion replaced, the same change cannot
			// be made here.
			const { original } = suggestion;
			const from = mark.start - (original.length - original.trimStart().length);
			const to = mark.end + (original.length - original.trimEnd().length);
			if (from < 0 || to > view.state.doc.length || view.state.sliceDoc(from, to) !== original) {
				applied = false;
				continue;
			}
			// An insertion has no text to check its place against. Over unsaved
			// typing it is left out, and the save check reports the difference,
			// rather than risk it landing in the wrong place.
			if (original === '' && !wasClean) {
				applied = false;
				continue;
			}
			// The server already holds this change, so it lands even while a
			// merge or duplicate has typing paused; dropped, the next save
			// would build on text the editor does not show.
			// With nothing unsaved it is also not an edit to save: the editor
			// stays clean, so a second accept right behind this one is applied
			// the same way.
			syncingFromServer = wasClean;
			try {
				view.dispatch({
					changes: { from, to, insert: replacements[id] ?? suggestion.replacement },
					effects: removeReviewMarks.of([id]),
					annotations: landsWhilePaused.of(true)
				});
			} finally {
				syncingFromServer = false;
			}
		}
		if (!accepted) return;
		// With nothing unsaved, and the change made on the text this editor
		// saved, the editor must now show exactly what the server stored. Where
		// a change could not be made here (an edit with no mark, such as one
		// that only removes a space), take the server's text. A change made on
		// other text (another window, a merge since) is left to the reload.
		if (
			wasClean &&
			saver.knows(accepted.baseHash) &&
			view.state.doc.toString() !== accepted.bodyMd
		) {
			syncingFromServer = true;
			try {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: accepted.bodyMd },
					annotations: landsWhilePaused.of(true)
				});
			} finally {
				syncingFromServer = false;
			}
			applied = true;
		}
		// With unsaved typing and a change that could not be made here, the save
		// check is left alone: the next save reports the difference.
		if (applied) saver.rebase(accepted.bodyMd, accepted.baseHash);
	}

	function rebuildMarks() {
		if (!view) return;
		view.dispatch({
			effects: setReviewMarks.of(
				buildReviewMarks(threads, suggestions, filter, view.state.doc.toString(), focusedId)
			)
		});
	}

	// ---- margin rail + floating selection toolbar, positioned from CM ----
	let markers = $state<RailMarker[]>([]);
	let sel = $state<{ left: number; top: number; start: number; end: number; text: string } | null>(
		null
	);

	function recomputeGeometry() {
		if (!view || !docEl) return;
		const docRect = docEl.getBoundingClientRect();
		const raw: RailMarker[] = [];

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
		markers = nudgeMarkers(raw);

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
		await autosave.flush();
		onStartComment({ start: captured.start, end: captured.end, text: captured.text });
	}
	async function startSuggest() {
		if (!sel) return;
		const captured = sel;
		sel = null;
		window.getSelection()?.removeAllRanges();
		await autosave.flush();
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
			if (!autosave.isDirty()) {
				if (view.state.doc.toString() !== incoming) {
					// The server's own text, so it lands even while typing is paused,
					// and it is not an edit to save: a save queued for it would be
					// refused when a second change lands before it goes.
					syncingFromServer = true;
					try {
						view.dispatch({
							changes: { from: 0, to: view.state.doc.length, insert: incoming },
							annotations: landsWhilePaused.of(true)
						});
					} finally {
						syncingFromServer = false;
					}
				}
				// Only once the editor shows it, or the next save would build on
				// text the writer never saw.
				if (view.state.doc.toString() === incoming) saver.adopt(incoming);
			}
			// With unsaved edits the next save is refused as a conflict, and the
			// banner lets the author choose.
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
	$effect(() => {
		const extension = pausedExtension(paused);
		if (!view) return;
		view.dispatch({ effects: pausedCompartment.reconfigure(extension) });
	});

	// Bring the focused passage into view when focus arrives from the panel/nav.
	// A whole-scene comment has no anchor, so take the reader to the scene start.
	$effect(() => {
		const id = focusedId;
		if (!id || !view) return;
		if (isWholeSceneNote(id, threads, suggestions)) {
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
						label: 'Scene text',
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
					pausedCompartment.of(pausedExtension(paused)),
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
			// Last-chance flush so navigating away does not lose the tail edit.
			void autosave.teardown().then(() => {
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
		{viewMenu}
		nonPrintingActive={nonPrinting === 'shown'}
		onToggleNonPrinting={toggleNonPrinting}
		commandMarkersActive={commands === 'shown'}
		onToggleCommandMarkers={toggleCommandMarkers}
	/>

	<div class="editor-scroll review-scroll">
		<div class="review-doc" bind:this={docEl}>
			{#if conflict}
				<SceneConflictBanner onLoadNewer={loadNewer} onKeepMine={keepMine} />
			{/if}
			<ReviewSceneHead
				{chapterTitle}
				sceneTitle={scene.title}
				{openComments}
				openSuggestions={openSugg}
			/>

			<div class="review-edit editor-cm" style={editorStyle} bind:this={editorEl}></div>

			<ReviewMarginRail {markers} {focusedId} {setFocused} />

			{#if sel}
				<ReviewSelectionToolbar
					left={sel.left}
					top={sel.top}
					{canSuggest}
					onComment={startComment}
					onSuggest={startSuggest}
				/>
			{/if}
		</div>
	</div>
</div>

<svelte:window onpagehide={autosave.flushOnPageHide} onbeforeunload={autosave.warnBeforeUnload} />
