<script lang="ts">
	import { reviewModal, closeReviewModal } from '$lib/review-modal.svelte';
	import { reviewSceneWithAssistant, startBackgroundReview } from '$lib/assistant-actions';
	import { REVIEW_CATEGORIES, type ReviewCategory, type ReviewLevel } from '$lib/review-shape';

	// The review modal: pick a level (this scene, this chapter, the whole story)
	// and which categories the Assistant should check, then start the review. The
	// page that owns the story renders this and supplies its chapters and scenes;
	// the open request comes from the shared store, raised by the row menu, the
	// command palette, the review pane, or the chat's /review command.

	let {
		storyId,
		storySlug,
		chapters,
		scenes,
		defaultSceneId = null
	}: {
		storyId: string;
		storySlug: string;
		chapters: { id: string; title: string | null }[];
		scenes: { id: string; chapterId: string | null; title: string | null }[];
		// The scene open in the editor, used when the request names no scene.
		defaultSceneId?: string | null;
	} = $props();

	const reviewHref = $derived(`/stories/${storySlug}/review`);

	// The scene and chapter the review can target, from the request or the page.
	const sceneId = $derived(reviewModal.request.sceneId ?? defaultSceneId ?? null);
	const scene = $derived(scenes.find((s) => s.id === sceneId) ?? null);
	const chapterId = $derived(reviewModal.request.chapterId ?? scene?.chapterId ?? null);
	const chapter = $derived(chapters.find((c) => c.id === chapterId) ?? null);

	function chapterLabel(c: { id: string; title: string | null }): string {
		if (c.title && c.title.trim()) return c.title;
		const i = chapters.findIndex((x) => x.id === c.id);
		return `Chapter ${i + 1}`;
	}

	// Which levels are offered, narrowed to what the context allows.
	const levels = $derived.by(() => {
		const out: { id: ReviewLevel; label: string }[] = [];
		if (sceneId) out.push({ id: 'scene', label: 'This scene' });
		if (chapterId) out.push({ id: 'chapter', label: 'This chapter' });
		out.push({ id: 'story', label: 'The whole story' });
		return out;
	});

	let level = $state<ReviewLevel>('story');
	// The category checkboxes. "General notes" is the sparing pass; the other
	// three are the exhaustive categories.
	let general = $state(true);
	let picked = $state<Record<ReviewCategory, boolean>>({
		mechanics: false,
		prose: false,
		lore: false
	});

	// Reset the form each time the modal opens, choosing the most specific level
	// the context offers.
	let lastOpen = false;
	$effect(() => {
		if (reviewModal.open && !lastOpen) {
			const requested = reviewModal.request.level;
			const available = levels.map((l) => l.id);
			level = requested && available.includes(requested) ? requested : (available[0] ?? 'story');
			general = true;
			picked = { mechanics: false, prose: false, lore: false };
		}
		lastOpen = reviewModal.open;
	});

	// The category set sent to the server: the exhaustive picks, or empty for the
	// sparing general-notes pass.
	const categories = $derived(REVIEW_CATEGORIES.filter((c) => picked[c]));

	const CATEGORY_OPTIONS: { id: ReviewCategory; label: string }[] = [
		{ id: 'mechanics', label: 'Spelling and grammar' },
		{ id: 'prose', label: 'Prose and style' },
		{ id: 'lore', label: 'Entities and lore' }
	];

	async function start() {
		closeReviewModal();
		if (level === 'scene' && sceneId) {
			await reviewSceneWithAssistant(
				sceneId,
				reviewHref,
				categories,
				scene?.title?.trim() ? `"${scene.title}"` : 'this scene'
			);
		} else if (level === 'chapter' && chapterId && chapter) {
			await startBackgroundReview({
				storyId,
				chapterId,
				categories,
				label: `"${chapterLabel(chapter)}"`,
				reviewHref
			});
		} else {
			await startBackgroundReview({ storyId, categories, label: 'your story', reviewHref });
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeReviewModal();
		}
	}
</script>

{#if reviewModal.open}
	<div
		class="review-modal-backdrop"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) closeReviewModal();
		}}
		onkeydown={onKeydown}
	>
		<div
			class="review-modal"
			role="dialog"
			aria-modal="true"
			aria-label="Review with the Assistant"
		>
			<h2 class="rm-title">Review with the Assistant</h2>

			<fieldset class="rm-group">
				<legend>What to review</legend>
				{#each levels as option (option.id)}
					<label class="rm-radio">
						<input type="radio" name="review-level" value={option.id} bind:group={level} />
						<span>{option.label}</span>
					</label>
				{/each}
			</fieldset>

			<fieldset class="rm-group">
				<legend>What to check</legend>
				<label class="rm-check">
					<input type="checkbox" bind:checked={general} disabled={categories.length > 0} />
					<span>
						General notes
						<span class="rm-hint">a few high-value observations</span>
					</span>
				</label>
				{#each CATEGORY_OPTIONS as option (option.id)}
					<label class="rm-check">
						<input type="checkbox" bind:checked={picked[option.id]} />
						<span>{option.label}</span>
					</label>
				{/each}
				<p class="rm-note">
					{#if categories.length === 0}
						The Assistant leaves a few high-value notes.
					{:else if categories.length === REVIEW_CATEGORIES.length}
						A full copyedit: every category, plus a cross-scene consistency pass.
					{:else}
						An exhaustive pass over the categories you picked.
					{/if}
				</p>
			</fieldset>

			<div class="rm-actions">
				<button class="btn" type="button" onclick={closeReviewModal}>Cancel</button>
				<button class="btn btn-primary" type="button" onclick={start}>Start review</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.review-modal-backdrop {
		position: fixed;
		inset: 0;
		background: color-mix(in oklab, var(--bg-canvas) 55%, transparent);
		backdrop-filter: blur(2px);
		z-index: 85;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 14vh;
	}
	.review-modal {
		width: min(420px, calc(100vw - 32px));
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 18px 20px 16px;
		font-family: var(--font-ui);
	}
	.rm-title {
		margin: 0 0 14px;
		font-size: 16px;
		font-weight: 600;
		color: var(--text);
	}
	.rm-group {
		border: 0;
		margin: 0 0 14px;
		padding: 0;
	}
	.rm-group legend {
		padding: 0;
		margin-bottom: 7px;
		font-size: 11px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.rm-radio,
	.rm-check {
		display: flex;
		align-items: baseline;
		gap: 9px;
		padding: 5px 0;
		font-size: 13.5px;
		color: var(--text);
		cursor: pointer;
	}
	.rm-radio input,
	.rm-check input {
		margin: 0;
		accent-color: var(--accent, currentColor);
	}
	.rm-hint {
		display: block;
		font-size: 12px;
		color: var(--text-faint);
	}
	.rm-note {
		margin: 8px 0 0;
		font-size: 12px;
		color: var(--text-faint);
	}
	.rm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
