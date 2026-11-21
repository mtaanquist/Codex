<script lang="ts">
	import { resolve } from '$app/paths';
	import { withQuery } from '#lib/href';
	import type { EntityProposalView, SplitProposalView } from '#lib/server/proposals';

	// What the Assistant or a connected app proposed for this universe and the
	// writer has not decided: entries it may be missing, and scene splits. The
	// forms post to the page's own actions (?/decideEntity, ?/decideSplit).
	let {
		entities,
		splits,
		message = '',
		done = ''
	}: {
		entities: EntityProposalView[];
		splits: SplitProposalView[];
		// The outcome of the last decision.
		message?: string;
		done?: string;
	} = $props();

	const KIND: Record<EntityProposalView['kind'], string> = {
		character: 'Character',
		place: 'Place',
		lore: 'Lore entry'
	};
</script>

{#if message}
	<p class="form-error" role="alert">{message}</p>
{/if}
{#if done}
	<p class="form-saved" role="status">{done}</p>
{/if}

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Suggested entries</h2>
		<p class="admin-block-sub">
			Characters, places and lore entries that your Assistant or a connected app found in your
			writing. Accept one to add it to this universe, or dismiss it. Nothing is added until you
			accept.
		</p>
	</div>
	{#if entities.length === 0}
		<div class="admin-card">
			<div class="empty-state tight">
				<p class="empty-state-text">No suggested entries are waiting.</p>
			</div>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each entities as entry (entry.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">{entry.name}</div>
							<div class="list-sub">{KIND[entry.kind]}. Suggested by {entry.from}.</div>
							{#if entry.description}
								<div class="list-sub">{entry.description}</div>
							{/if}
							{#if entry.seenIn}
								<div class="list-sub">Seen in: {entry.seenIn}</div>
							{/if}
						</div>
						<form method="POST" action="?/decideEntity" class="list-actions">
							<input type="hidden" name="id" value={entry.id} />
							<button
								type="submit"
								name="decision"
								value="accept"
								class="btn btn-primary btn-sm"
								aria-label="Accept {entry.name}">Accept</button
							>
							<button
								type="submit"
								name="decision"
								value="dismiss"
								class="btn btn-ghost btn-sm"
								aria-label="Dismiss {entry.name}">Dismiss</button
							>
						</form>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Proposed scene splits</h2>
		<p class="admin-block-sub">
			Places where a connected app thinks a scene should become two. Select "Split here" to split
			the scene at the quoted words, or dismiss the proposal. The scene stays as it is until you
			split it.
		</p>
	</div>
	{#if splits.length === 0}
		<div class="admin-card">
			<div class="empty-state tight">
				<p class="empty-state-text">No proposed splits are waiting.</p>
			</div>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each splits as split (split.id)}
					{@const sceneName = split.sceneTitle ?? 'Untitled scene'}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								<a
									href={withQuery(resolve('/stories/[id]', { id: split.storyId }), {
										scene: split.sceneId
									})}>{sceneName}</a
								>
								in {split.storyTitle}
							</div>
							<div class="list-sub">Proposed by {split.from}.</div>
							{#if split.rationale}
								<div class="list-sub">{split.rationale}</div>
							{/if}
							<div class="list-sub">The new scene would start at: "{split.before}"</div>
						</div>
						<form method="POST" action="?/decideSplit" class="list-actions">
							<input type="hidden" name="id" value={split.id} />
							<button
								type="submit"
								name="decision"
								value="confirm"
								class="btn btn-primary btn-sm"
								aria-label="Split {sceneName} here">Split here</button
							>
							<button
								type="submit"
								name="decision"
								value="dismiss"
								class="btn btn-ghost btn-sm"
								aria-label="Dismiss the split of {sceneName}">Dismiss</button
							>
						</form>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
