<script lang="ts">
	import { invalidateAll, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EntityEditor from '$lib/components/EntityEditor.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import OutlineNodeEditor from '$lib/components/OutlineNodeEditor.svelte';
	import SceneBoard from '$lib/components/SceneBoard.svelte';
	import PlanSidebar from '$lib/components/PlanSidebar.svelte';
	import RevisionHistory from '$lib/components/RevisionHistory.svelte';
	import RevisionPreview from '$lib/components/RevisionPreview.svelte';
	import type { SaveStatus } from '$lib/components/SceneEditor.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saveStatus = $state<SaveStatus>('idle');
	const selectedId = $derived(data.selected?.id ?? data.selectedNode?.id);
	$effect(() => {
		void selectedId;
		saveStatus = 'idle';
	});

	const planPath = $derived(resolve('/stories/[id]/plan', { id: data.story.id }));

	// Right column tabs; History holds the open item's timeline.
	let rightTab = $state<'reference' | 'history'>('reference');
	const itemHref = $derived(
		data.selected
			? `${planPath}?entity=${data.selected.id}`
			: data.selectedNode
				? `${planPath}?node=${data.selectedNode.id}`
				: planPath
	);
	const currentBody = $derived(data.selected?.bodyMd ?? data.selectedNode?.bodyMd ?? '');

	// Outline drag-to-reorder. Restricted to one sibling group: the dragged
	// node can only drop between nodes that share its parent; indent and
	// outdent move between levels instead.
	let draggingNodeId = $state<string | null>(null);
	let nodeDrop = $state<{ markerId: string; after: boolean } | null>(null);
	const draggingNode = $derived(data.outline.find((node) => node.id === draggingNodeId));

	function siblingsOf(parentId: string | null) {
		return data.outline.filter((node) => node.parentId === parentId);
	}

	function overNode(event: DragEvent, node: (typeof data.outline)[number]) {
		if (!draggingNode || node.parentId !== draggingNode.parentId || node.id === draggingNode.id) {
			return;
		}
		event.preventDefault();
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		nodeDrop = { markerId: node.id, after: event.clientY > rect.top + rect.height / 2 };
	}

	async function dropNode(event: DragEvent) {
		event.preventDefault();
		if (!draggingNode || !nodeDrop) return;
		const parentId = draggingNode.parentId;
		const order = siblingsOf(parentId).map((node) => node.id);
		const from = order.indexOf(draggingNode.id);
		order.splice(from, 1);
		let to = order.indexOf(nodeDrop.markerId) + (nodeDrop.after ? 1 : 0);
		if (to < 0) to = order.length;
		order.splice(to, 0, draggingNode.id);
		draggingNodeId = null;
		nodeDrop = null;
		await fetch(`/api/stories/${data.story.id}/outline-order`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ parentId, order })
		});
		await invalidateAll();
	}

	function endNodeDrag() {
		draggingNodeId = null;
		nodeDrop = null;
	}

	async function moveNode(nodeId: string, direction: 'indent' | 'outdent') {
		const response = await fetch(`/api/outline/${nodeId}/move`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ direction })
		});
		if (response.ok) await invalidateAll();
	}
</script>

<svelte:head>
	<title>{data.story.title} - Plan - Codex</title>
</svelte:head>

<div class="app">
	<TopBar
		universe={{ id: data.universe.id, name: data.universe.name }}
		story={{ id: data.story.id, title: data.story.title }}
		{saveStatus}
		help={{ topic: 'planning', label: 'the planning view' }}
	/>
	<div class="body">
		<PlanSidebar
			characters={data.characters}
			places={data.places}
			categories={data.categories}
			lore={data.lore}
			{selectedId}
			{planPath}
			writeHref={resolve('/stories/[id]', { id: data.story.id })}
			{form}
			availableCharacters={data.availableCharacters}
			availablePlaces={data.availablePlaces}
		>
			{#snippet before()}
				<div class="group-label">
					<span class="gl-left">Outline</span>
					<span class="count">{data.outline.length}</span>
				</div>
				<div class="o-tree" role="list" ondragend={endNodeDrag}>
					{#each data.outline as node, index (node.id)}
						{@const siblingIndex = siblingsOf(node.parentId).findIndex(
							(sibling) => sibling.id === node.id
						)}
						<div
							class="o-row"
							class:active={node.id === data.selectedNode?.id}
							class:drop-before={nodeDrop?.markerId === node.id && !nodeDrop.after}
							class:drop-after={nodeDrop?.markerId === node.id && nodeDrop.after}
							role="listitem"
							draggable="true"
							style="padding-left: {8 + node.depth * 14}px"
							ondragstart={(event) => {
								draggingNodeId = node.id;
								event.dataTransfer?.setData('text/plain', String(index));
							}}
							ondragover={(event) => overNode(event, node)}
							ondrop={dropNode}
						>
							<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
							<a class="o-title" href={`${planPath}?node=${node.id}`}>{node.title}</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{#if node.linkedSceneId || node.linkedChapterId}
								<span class="o-linked" title="Linked to the draft">
									<Icon name={node.linkedSceneId ? 'scene' : 'chapter'} size={11} />
								</span>
							{/if}
							<span class="o-tools">
								<button
									type="button"
									title="Outdent"
									disabled={node.depth === 0}
									onclick={() => moveNode(node.id, 'outdent')}
								>
									&lt;
								</button>
								<button
									type="button"
									title="Indent"
									disabled={siblingIndex === 0}
									onclick={() => moveNode(node.id, 'indent')}
								>
									&gt;
								</button>
							</span>
						</div>
					{/each}
				</div>
				<form method="POST" action="?/createOutlineNode" class="new-node">
					{#if form?.kind === 'outline' && form.message}
						<p class="error" role="alert">{form.message}</p>
					{/if}
					<input type="text" name="title" placeholder="New outline node" required />
					<button class="outline-add" type="submit">
						<Icon name="plus" size={13} /> Add node
					</button>
				</form>
			{/snippet}
		</PlanSidebar>
		<main class="pane center">
			{#if data.revisionPreview && data.revisionTarget}
				<div class="detail">
					<RevisionPreview
						revision={data.revisionPreview}
						{currentBody}
						entityType={data.revisionTarget.type}
						entityId={data.revisionTarget.id}
						exitHref={itemHref}
					/>
				</div>
			{:else if data.selectedNode}
				{#key data.selectedNode.id}
					<OutlineNodeEditor
						node={data.selectedNode}
						storyId={data.story.id}
						chapters={data.chapters}
						scenes={data.scenes}
						onStatus={(status) => (saveStatus = status)}
						onDeleted={async () => {
							await goto(planPath, { invalidateAll: true });
						}}
					/>
				{/key}
			{:else if data.selected}
				{#key data.selected.id}
					<EntityEditor
						kind={data.selectedKind}
						entity={data.selected}
						categories={data.categories}
						relationTypes={data.relationTypes}
						relationships={data.relationships}
						targets={{
							character: data.universeCharacters,
							place: data.universePlaces,
							lore_entry: data.lore
						}}
						storyId={data.story.id}
						storyNotesMd={data.storyNotesMd}
						membership={data.membership}
						entityHref={(id) => `${planPath}?entity=${id}`}
						onStatus={(status) => (saveStatus = status)}
					/>
				{/key}
			{:else if data.scenes.length > 0}
				<!-- With nothing selected, the centre is the scene board. -->
				<SceneBoard
					scenes={data.scenes}
					chapters={data.chapters}
					todoCounts={data.todoCounts}
					sceneHref={(sceneId) =>
						`${resolve('/stories/[id]', { id: data.story.id })}?scene=${sceneId}`}
					onMove={async (sceneId, status) => {
						await fetch(`/api/scenes/${sceneId}`, {
							method: 'PATCH',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ status })
						});
						await invalidateAll();
					}}
				/>
			{:else if data.characters.length === 0 && data.places.length === 0}
				<div class="empty">
					<p>Nothing here yet. Add a character or a place in the sidebar.</p>
				</div>
			{:else}
				<div class="empty">
					<p>Select a character or place in the sidebar.</p>
				</div>
			{/if}
		</main>
		<aside class="pane right">
			{#if data.revisionTarget}
				<div class="right-head">
					<div class="rtabs">
						<button
							class="rtab"
							class:active={rightTab === 'reference'}
							type="button"
							onclick={() => (rightTab = 'reference')}
						>
							Reference
						</button>
						<button
							class="rtab"
							class:active={rightTab === 'history'}
							type="button"
							onclick={() => (rightTab = 'history')}
						>
							History
						</button>
					</div>
				</div>
			{/if}
			{#if data.revisionTarget && rightTab === 'history'}
				<RevisionHistory
					entityType={data.revisionTarget.type}
					entityId={data.revisionTarget.id}
					revisions={data.revisionRows}
					previewId={data.revisionPreview?.id}
					previewHref={(revisionId) => `${itemHref}&revision=${revisionId}`}
				/>
			{:else}
				<div class="right-scroll">
					{#if data.selected && data.relationships.length > 0}
						<div class="r-card">
							<h5>Relationships</h5>
							{#each data.relationships as relationship (relationship.id)}
								<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
								<a class="r-line" href={`${planPath}?entity=${relationship.otherId}`}>
									<span class="r-line-left">
										<span class="rel-label">{relationship.label}</span>
										<span class="r-line-name">{relationship.otherName}</span>
									</span>
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/each}
						</div>
					{/if}
					{#if data.selected && data.appearsIn.length > 0}
						{@const scenesSeen = [...new Map(data.appearsIn.map((m) => [m.sceneId, m])).values()]}
						<div class="r-card">
							<h5>Appears in</h5>
							{#each scenesSeen as sceneRef (sceneRef.sceneId)}
								{@const mentions = data.appearsIn.filter((m) => m.sceneId === sceneRef.sceneId)}
								<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
								<a
									class="r-line"
									href={`${resolve('/stories/[id]', { id: data.story.id })}?scene=${sceneRef.sceneId}`}
								>
									<span class="r-line-left">
										<span class="r-line-name">{sceneRef.sceneTitle ?? 'Untitled scene'}</span>
									</span>
									<span class="r-count">{mentions.length}</span>
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								{#each mentions as mention, mi (mi)}
									<div class="snippet">{mention.snippet}</div>
								{/each}
							{/each}
						</div>
					{:else if data.selected}
						<div class="empty">
							No mentions in this story yet. Mentions appear shortly after the prose is saved.
						</div>
					{:else}
						<div class="empty">Mentions and relationships arrive here.</div>
					{/if}
					{#if data.selected}
						<div class="r-card mentions-card">
							<span>All mentions</span>
							<span class="r-count">{data.mentionTotal}</span>
						</div>
					{/if}
				</div>
			{/if}
		</aside>
	</div>
</div>

<style>
	.r-line {
		text-decoration: none;
	}
	.rel-label {
		color: var(--text-muted);
		font-size: 12px;
		margin-right: 6px;
	}
	.o-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-top: 3px;
		padding-bottom: 3px;
		padding-right: 8px;
		border-top: 2px solid transparent;
		border-bottom: 2px solid transparent;
		font-size: 13px;
	}
	.o-row.active {
		background: var(--bg-inset);
	}
	.o-row.drop-before {
		border-top-color: var(--accent-line, #888);
	}
	.o-row.drop-after {
		border-bottom-color: var(--accent-line, #888);
	}
	.o-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-decoration: none;
		color: var(--text);
	}
	.o-linked {
		color: var(--text-faint);
		display: inline-flex;
	}
	.o-tools {
		display: none;
		gap: 2px;
	}
	.o-row:hover .o-tools {
		display: inline-flex;
	}
	.o-tools button {
		border: 0;
		background: none;
		color: var(--text-faint);
		font-size: 12px;
		line-height: 1;
		padding: 2px 4px;
		cursor: pointer;
	}
	.o-tools button:hover:not(:disabled) {
		color: var(--text);
	}
	.o-tools button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.new-node {
		margin-top: 10px;
		padding: 0 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.new-node input {
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 6px);
		color: var(--text);
		font-size: 13px;
		padding: 7px 9px;
		outline: none;
	}
	.new-node input:focus {
		border-color: var(--accent-line);
	}
	.new-node input::placeholder {
		color: var(--text-faint);
	}
	.error {
		color: var(--danger, #b00020);
		font-size: 12.5px;
		margin: 0;
	}
	.snippet {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.5;
		padding: 2px 0 6px;
		border-bottom: 1px dashed var(--border);
	}
	.mentions-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.mentions-card span:first-child {
		font-size: 13.5px;
		font-weight: 600;
	}
</style>
