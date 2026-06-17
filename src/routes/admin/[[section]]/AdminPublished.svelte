<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { formatDate } from '$lib/format';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const liveEditions = $derived(data.published.filter((e) => !e.removedAt));
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Data</p>
	<h1 class="admin-title">Published editions</h1>
	<p class="admin-lede">
		Everything writers have made public. Take an edition down to remove it from the public pages.
	</p>
</div>

{#if form?.scope === 'published' && form.message}
	<div
		class="status-banner"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">{form.message}</span>
	</div>
{/if}

<div class="admin-block">
	{#if liveEditions.length === 0}
		<div class="admin-card">
			<p class="admin-block-sub" style="margin:0;">Nothing is published right now.</p>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each liveEditions as edition (edition.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								@{edition.handle}/{edition.title}
								<span class="pill">{edition.isCurrent ? 'current' : 'superseded'}</span>
								{#if edition.isAdult}<span class="pill">adult</span>{/if}
							</div>
							<div class="list-sub">published {formatDate(edition.publishedAt)}</div>
						</div>
						<div class="list-actions">
							<form method="POST" action="?/takedown">
								<input type="hidden" name="publicationId" value={edition.id} />
								<button type="submit" class="btn btn-ghost btn-sm" style="color:var(--danger);"
									>Take down</button
								>
							</form>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
