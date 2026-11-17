<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import AppBar from '#lib/components/AppBar.svelte';
	import DiffView from '#lib/components/DiffView.svelte';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { storyPath } from '#lib/chrome';
	import { confirmEnhance } from '#lib/confirm.svelte';
	import { enhance } from '#lib/enhance';
	import {
		draftOutline,
		type DraftEntityType,
		type DraftScene,
		type SceneChangeKind
	} from '#lib/drafts';
	import { formatDateTime, formatNumber } from '#lib/format';
	import { withQuery } from '#lib/href';
	import { renderMarkdown } from '#lib/markdown';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const content = $derived(data.draft.content);
	const outline = $derived(draftOutline(content));
	const draftHref = $derived(
		resolve('/stories/[id]/drafts/[draft=uuid]', { id: data.story.slug, draft: data.draft.id })
	);
	const workingHref = $derived(resolve('/stories/[id]', { id: data.story.slug }));
	const manageHref = $derived(
		resolve('/stories/[id]/settings/[[section]]', { id: data.story.slug, section: 'drafts' })
	);
	const publishHref = $derived(
		withQuery(
			resolve('/stories/[id]/settings/[[section]]', { id: data.story.slug, section: 'publish' }),
			{ draft: data.draft.id }
		)
	);
	const savedAt = $derived(formatDateTime(data.draft.createdAt, page.data.timeZone));

	const TAB_LABELS = {
		story: 'Story',
		world: 'Worldbuilding',
		notes: 'Notes',
		compare: 'Compare'
	} as const;

	// Scenes open for comparison, by id.
	let comparing = $state<Record<string, boolean>>({});
	let newStoryOpen = $state(false);
	// A failed submit keeps the form open, with its message, until closed.
	$effect(() => {
		if (form?.action === 'newStory') newStoryOpen = true;
	});
	const restoreResult = $derived(form?.action === 'restore' ? form : null);
	// The result of restoring a scene shows on that scene.
	function restoreMessage(sceneId: string) {
		return restoreResult && 'sceneId' in restoreResult && restoreResult.sceneId === sceneId
			? restoreResult
			: null;
	}

	type SceneState = 'same' | 'changed' | 'missing';
	function sceneState(scene: DraftScene): SceneState {
		const live = data.live[scene.id];
		if (live === undefined) return 'missing';
		return live === scene.bodyMd ? 'same' : 'changed';
	}
	const STATE_LABEL: Record<SceneState, string> = {
		same: 'Same as the working draft',
		changed: 'Changed since',
		missing: 'Not in the working draft'
	};

	const KIND_HEADINGS: Record<DraftEntityType, string> = {
		character: 'Characters',
		place: 'Places',
		lore_entry: 'Lore'
	};
	const entityName = $derived(new Map(content.entities.map((entity) => [entity.id, entity.name])));
	// Names first by how often the draft uses them, then alphabetically.
	function entitiesOf(type: DraftEntityType) {
		return content.entities
			.filter((entity) => entity.type === type)
			.sort(
				(a, b) =>
					(data.mentions[b.id] ?? 0) - (data.mentions[a.id] ?? 0) || a.name.localeCompare(b.name)
			);
	}
	function relationshipsOf(id: string) {
		return content.relationships
			.filter((relationship) => relationship.fromId === id || relationship.toId === id)
			.map((relationship) =>
				relationship.fromId === id
					? `${relationship.label} ${entityName.get(relationship.toId) ?? 'someone since removed'}`
					: `${entityName.get(relationship.fromId) ?? 'Someone since removed'} ${relationship.label} this`
			);
	}
	function namedLine(count: number): string {
		if (count === 0) return 'Not named in this draft';
		return count === 1 ? 'Named once' : `Named ${formatNumber(count)} times`;
	}
	const CHANGE_LABEL: Record<SceneChangeKind, string> = {
		same: 'Unchanged',
		changed: 'Changed',
		added: 'Added',
		removed: 'Removed'
	};
	function signed(n: number): string {
		return n > 0 ? `+${formatNumber(n)}` : n < 0 ? `-${formatNumber(-n)}` : '0';
	}
	function scenes(n: number): string {
		return n === 1 ? '1 scene' : `${formatNumber(n)} scenes`;
	}
	// Compare cards that have been opened, by kind and scene id.
	let opened = $state<Record<string, boolean>>({});
	const otherDrafts = $derived(data.drafts.filter((draft) => draft.id !== data.draft.id));
	const sceneTitle = $derived(
		new Map(content.scenes.map((scene) => [scene.id, scene.title ?? 'Untitled scene']))
	);
</script>

<svelte:head>
	<title>{data.draft.label} - {data.story.title} - Codex</title>
</svelte:head>

<div class="page-shell">
	<AppBar
		crumbs={storyPath(
			data.universe,
			{ ...data.story, reading: data.reading },
			{ drafts: { list: data.drafts, at: data.draft.id } }
		)}
		helpTopic="drafts"
		helpLabel="saved drafts"
	/>

	<main id="main" class="page-body">
		<div class="page-container draft-page">
			<div class="page-header draft-head">
				<div>
					<p class="admin-eyebrow">Saved draft of {data.story.title}</p>
					<h1 class="page-title">{data.draft.label}</h1>
					<p class="page-subtitle">
						Saved {savedAt} - {formatNumber(data.draft.wordCount)} words
					</p>
				</div>
				<div class="page-actions">
					<a class="btn btn-secondary" href={manageHref}>Rename or delete</a>
					{#if data.canPublish}
						<a class="btn btn-secondary" href={publishHref}>Publish this draft</a>
					{/if}
					<button
						class="btn btn-secondary"
						type="button"
						aria-expanded={newStoryOpen}
						onclick={() => (newStoryOpen = !newStoryOpen)}
					>
						New story from this draft
					</button>
				</div>
			</div>

			{#if data.draft.noteMd}
				<p class="draft-note">{data.draft.noteMd}</p>
			{/if}

			<div class="revision-banner">
				<div class="revision-banner-icon"><Icon name="clock" size={16} /></div>
				<div class="revision-banner-main">
					<div class="revision-banner-title">You are reading a saved draft</div>
					<div class="revision-banner-sub">
						It stays exactly as it was saved. Your working draft is where you write.
					</div>
				</div>
				<div class="revision-banner-actions">
					<a class="btn btn-sm btn-primary" href={workingHref}>Back to the working draft</a>
				</div>
			</div>

			{#if newStoryOpen}
				<form class="admin-card new-story" method="POST" action="?/newStory" use:enhance>
					<div class="field">
						<label for="draft-new-title">Title of the new story</label>
						<input
							id="draft-new-title"
							class="input"
							name="title"
							value="{content.story.title} ({data.draft.label})"
							maxlength="200"
						/>
						<p class="field-hint">
							The new story starts as a copy of this draft, in the same universe. This story stays
							as it is.
						</p>
					</div>
					<FormStatus error={form?.action === 'newStory' ? form.message : null} block />
					<div class="settings-actions">
						<button class="btn btn-primary" type="submit">Make the new story</button>
						<button class="btn btn-ghost" type="button" onclick={() => (newStoryOpen = false)}>
							Cancel
						</button>
					</div>
				</form>
			{/if}

			<nav class="seg draft-tabs" aria-label="Parts of the draft">
				{#each Object.entries(TAB_LABELS) as [tab, label] (tab)}
					<a
						class="seg-btn"
						class:active={data.tab === tab}
						href={tab === 'story' ? draftHref : withQuery(draftHref, { tab })}
						aria-current={data.tab === tab ? 'page' : undefined}
					>
						{label}
					</a>
				{/each}
			</nav>

			{#if data.tab === 'story'}
				{#if content.scenes.length === 0}
					<div class="empty-state">
						<p class="empty-state-text">This draft was saved before any scenes were written.</p>
					</div>
				{/if}

				{#snippet sceneBlock(scene: DraftScene)}
					{@const state = sceneState(scene)}
					{@const result = restoreMessage(scene.id)}
					<section class="draft-scene" aria-labelledby="draft-scene-{scene.id}">
						<div class="draft-scene-head">
							<h3 id="draft-scene-{scene.id}">{scene.title ?? 'Untitled scene'}</h3>
							<span class="draft-scene-state" class:changed={state !== 'same'}>
								{STATE_LABEL[state]}
							</span>
							<div class="draft-scene-tools">
								{#if state === 'changed'}
									<button
										class="btn btn-sm btn-ghost"
										type="button"
										aria-pressed={comparing[scene.id] ?? false}
										onclick={() => (comparing[scene.id] = !comparing[scene.id])}
									>
										{comparing[scene.id] ? 'Show this draft' : 'Compare with working draft'}
									</button>
								{/if}
								{#if state !== 'same'}
									<form
										method="POST"
										action="?/restoreScene"
										use:enhance={confirmEnhance(
											state === 'missing'
												? {
														title: 'Add this scene back?',
														body: 'A new scene with this text is added to the working draft.',
														confirmLabel: 'Add scene'
													}
												: {
														title: 'Restore this scene?',
														body: 'The scene in the working draft gets this text. The text it has now is kept in its History, so you can undo this.',
														confirmLabel: 'Restore scene'
													}
										)}
									>
										<input type="hidden" name="sceneId" value={scene.id} />
										<button class="btn btn-sm btn-secondary" type="submit">
											{state === 'missing' ? 'Add back to working draft' : 'Restore this scene'}
										</button>
									</form>
								{/if}
							</div>
						</div>
						{#if result && 'message' in result}
							<FormStatus error={result.message} block />
						{:else if result && 'restoredSceneId' in result}
							<p class="field-hint restored" role="status">
								{result.created
									? 'The scene was added back to the working draft.'
									: 'The scene in the working draft now has this text. The text it replaced is in its History.'}
								<a href={withQuery(workingHref, { scene: result.restoredSceneId })}
									>Open the scene</a
								>
							</p>
						{/if}
						{#if comparing[scene.id] && state === 'changed'}
							<p class="field-hint">
								Green text was added in the working draft since. Red, struck-through text was taken
								out.
							</p>
							<DiffView class="reader-prose" from={scene.bodyMd} to={data.live[scene.id] ?? ''} />
						{:else}
							<div class="reader-prose">
								<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
								{@html renderMarkdown(scene.bodyMd)}
							</div>
						{/if}
					</section>
				{/snippet}

				{#each outline.chapters as chapter, index (chapter.id)}
					<section class="draft-chapter">
						<h2>{chapter.title ?? `Chapter ${index + 1}`}</h2>
						{#if chapter.summaryMd}<p class="field-hint">{chapter.summaryMd}</p>{/if}
						{#each chapter.scenes as scene (scene.id)}
							{@render sceneBlock(scene)}
						{/each}
					</section>
				{/each}
				{#if outline.unfiled.length > 0}
					<section class="draft-chapter">
						<h2>Unfiled scenes</h2>
						{#each outline.unfiled as scene (scene.id)}
							{@render sceneBlock(scene)}
						{/each}
					</section>
				{/if}
			{:else if data.tab === 'world'}
				<p class="field-hint">
					The characters, places, and lore of {data.universe.name} as they were when this draft was saved.
				</p>
				{#if content.entities.length === 0}
					<div class="empty-state">
						<p class="empty-state-text">
							There was no worldbuilding yet when this draft was saved.
						</p>
					</div>
				{/if}
				{#each ['character', 'place', 'lore_entry'] as const as type (type)}
					{@const list = entitiesOf(type)}
					{#if list.length > 0}
						<h2 class="draft-kind">{KIND_HEADINGS[type]}</h2>
						<div class="draft-entities">
							{#each list as entity (entity.id)}
								{@const related = relationshipsOf(entity.id)}
								<details class="r-card draft-entity">
									<summary>
										<span class="draft-entity-caret"><Icon name="caret" size={11} /></span>
										<span class="draft-entity-name">{entity.name}</span>
										{#if entity.categoryName}
											<span class="pill">{entity.categoryName}</span>
										{/if}
										{#if entity.inStory}<span class="pill pill-accent">In this story</span>{/if}
										<span class="draft-entity-count">
											{namedLine(data.mentions[entity.id] ?? 0)}
										</span>
									</summary>
									{#if entity.aliases.length > 0}
										<p class="field-hint">
											{type === 'lore_entry' ? 'Keywords' : 'Also called'}: {entity.aliases.join(
												', '
											)}
										</p>
									{/if}
									{#if entity.summaryMd}<p>{entity.summaryMd}</p>{/if}
									{#if entity.details.length > 0}
										<dl class="draft-details">
											{#each entity.details as detail, index (index)}
												<dt>{detail.label}</dt>
												<dd>{detail.value}</dd>
											{/each}
										</dl>
									{/if}
									{#if related.length > 0}
										<ul class="draft-related">
											{#each related as line, index (index)}<li>{line}</li>{/each}
										</ul>
									{/if}
									{#if entity.bodyMd}
										<div class="draft-entity-body">
											<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
											{@html renderMarkdown(entity.bodyMd)}
										</div>
									{/if}
									{#if entity.storyNotesMd}
										<p class="draft-sub">Notes for this story</p>
										<div class="draft-entity-body">
											<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
											{@html renderMarkdown(entity.storyNotesMd)}
										</div>
									{/if}
								</details>
							{/each}
						</div>
					{/if}
				{/each}
			{:else if data.tab === 'compare' && data.compare}
				{@const compare = data.compare}
				<form class="compare-pick" method="GET" action={draftHref}>
					<input type="hidden" name="tab" value="compare" />
					<label for="compare-with">Compare with</label>
					<select id="compare-with" class="select" name="with" value={compare.with}>
						<option value="working">Working draft</option>
						{#each otherDrafts as other (other.id)}
							<option value={other.id}>{other.label}</option>
						{/each}
					</select>
					<button class="btn btn-sm btn-secondary" type="submit">Compare</button>
				</form>
				<p class="compare-summary">
					From "{compare.older}" to "{compare.newer}": {scenes(compare.counts.changed)} changed, {scenes(
						compare.counts.added
					)} added, {scenes(compare.counts.removed)} removed. {formatNumber(compare.words.before)} words
					to {formatNumber(compare.words.after)} ({signed(
						compare.words.after - compare.words.before
					)}).
				</p>
				{#if compare.chapterRenames.length > 0}
					<ul class="compare-renames">
						{#each compare.chapterRenames as rename (rename.before + rename.after)}
							<li>Chapter "{rename.before}" is now "{rename.after}".</li>
						{/each}
					</ul>
				{/if}
				{#if compare.counts.changed + compare.counts.added + compare.counts.removed === 0}
					<div class="empty-state">
						<p class="empty-state-text">The scenes are the same in both.</p>
					</div>
				{:else}
					<p class="field-hint">
						Open a scene to see its text. In a changed scene, green text was added and red,
						struck-through text was taken out.
					</p>
				{/if}
				<div class="draft-entities">
					{#each compare.changes as change (`${change.kind}:${(change.after ?? change.before)!.id}`)}
						{@const scene = (change.after ?? change.before)!}
						{@const key = `${change.kind}:${scene.id}`}
						<details
							class="r-card draft-entity compare-scene"
							ontoggle={(event) => (opened[key] = event.currentTarget.open)}
						>
							<summary>
								<span class="draft-entity-caret"><Icon name="caret" size={11} /></span>
								<span class="draft-entity-name">{scene.title ?? 'Untitled scene'}</span>
								{#if change.chapterTitle}<span class="pill">{change.chapterTitle}</span>{/if}
								<span class="pill" class:pill-accent={change.kind !== 'removed'}>
									{CHANGE_LABEL[change.kind]}
								</span>
								<span class="draft-entity-count">
									{signed((change.after?.wordCount ?? 0) - (change.before?.wordCount ?? 0))} words
								</span>
							</summary>
							<!-- The text is drawn only once the card is opened. -->
							{#if opened[key] && change.kind === 'changed' && change.before && change.after}
								{#each change.notes as note (note)}
									<p class="field-hint">{note}.</p>
								{/each}
								<DiffView
									class="reader-prose"
									from={change.before.bodyMd}
									to={change.after.bodyMd}
								/>
							{:else if opened[key]}
								<div class="reader-prose">
									<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
									{@html renderMarkdown(scene.bodyMd)}
								</div>
							{/if}
						</details>
					{/each}
				</div>
				{#if compare.counts.same > 0}
					<p class="field-hint compare-same">
						{scenes(compare.counts.same)} unchanged.
					</p>
				{/if}
			{:else}
				{#if content.notes.length === 0}
					<div class="empty-state">
						<p class="empty-state-text">This story had no notes when the draft was saved.</p>
					</div>
				{/if}
				<div class="draft-entities">
					{#each content.notes as note (note.id)}
						<article class="r-card draft-entity">
							<h2 class="draft-entity-name">{note.title ?? 'Untitled note'}</h2>
							{#if note.sceneId && sceneTitle.has(note.sceneId)}
								<p class="field-hint">On the scene "{sceneTitle.get(note.sceneId)}"</p>
							{/if}
							<div class="draft-entity-body">
								<!-- eslint-disable-next-line svelte/no-at-html-tags (shared renderer escapes raw HTML) -->
								{@html renderMarkdown(note.bodyMd)}
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</div>
	</main>
</div>

<style>
	.draft-page {
		max-width: 52rem;
	}
	.draft-note {
		white-space: pre-wrap;
		color: var(--text-muted);
		margin: calc(-1 * var(--space-5)) 0 var(--space-6);
	}
	.new-story {
		margin-bottom: var(--space-6);
	}
	.draft-tabs {
		margin-bottom: var(--space-6);
		width: fit-content;
	}
	.draft-tabs a {
		text-decoration: none;
	}
	.restored {
		color: var(--status-final-ink);
	}
	.draft-chapter h2,
	.draft-kind {
		font-family: var(--font-serif);
		font-size: 23px;
		font-weight: 600;
		margin: var(--space-8) 0 var(--space-4);
	}
	.draft-scene {
		margin-bottom: var(--space-8);
	}
	.draft-scene-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-bottom: var(--space-3);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border);
	}
	.draft-scene-head h3 {
		font-size: var(--text-lg);
		font-weight: 650;
		margin: 0;
	}
	.draft-scene-state {
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.draft-scene-state.changed {
		color: var(--text-muted);
	}
	.draft-scene-tools {
		margin-left: auto;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.compare-pick {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-bottom: var(--space-4);
	}
	.compare-summary {
		margin: 0 0 var(--space-2);
	}
	.compare-renames {
		margin: 0 0 var(--space-2);
		padding-left: var(--space-5);
	}
	.compare-same {
		margin-top: var(--space-4);
	}
	.draft-entities {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.draft-entity summary {
		display: flex;
		list-style: none;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		cursor: pointer;
	}
	.draft-entity summary::-webkit-details-marker {
		display: none;
	}
	.draft-entity-caret {
		display: inline-flex;
		color: var(--text-faint);
		transform: rotate(-90deg);
		transition: transform 0.14s;
	}
	.draft-entity[open] .draft-entity-caret {
		transform: none;
	}
	.draft-entity-name {
		font-weight: 650;
		font-size: var(--text-base);
		margin: 0;
	}
	.draft-entity-count {
		margin-left: auto;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.draft-entity-body {
		font-size: var(--text-base);
		line-height: 1.6;
	}
	.draft-sub {
		font-size: var(--text-micro);
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin: var(--space-4) 0 var(--space-1);
	}
	.draft-details {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-4);
		font-size: var(--text-sm);
	}
	.draft-details dt {
		color: var(--text-faint);
	}
	.draft-details dd {
		margin: 0;
	}
	.draft-related {
		font-size: var(--text-sm);
		color: var(--text-muted);
		padding-left: 1.2em;
	}
	@media (max-width: 640px) {
		.draft-head {
			flex-direction: column;
			align-items: flex-start;
		}
		.draft-head > :global(.page-actions) {
			flex-wrap: wrap;
		}
		.draft-scene-tools {
			margin-left: 0;
		}
		.draft-page :global(.revision-banner) {
			flex-wrap: wrap;
		}
	}
</style>
