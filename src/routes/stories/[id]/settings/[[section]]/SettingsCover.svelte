<script lang="ts">
	import { entityColor } from '$lib/entity-color';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const coverColor = $derived(entityColor(data.story.title));
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Cover</h2>
	<p class="admin-block-sub">Shown on your public shelf and inside the EPUB.</p>
</div>
<div class="settings-group">
	{#if data.story.coverAssetId}
		<img class="cover" src="/assets/{data.story.coverAssetId}" alt="Story cover" />
	{:else}
		<svg class="cover" viewBox="0 0 200 300" role="img" aria-label="Default cover">
			<rect width="200" height="300" rx="6" style="fill: {coverColor}" />
			<text x="100" y="150" text-anchor="middle" fill="#fff" font-size="16" font-family="serif">
				{data.story.title.slice(0, 18)}
			</text>
		</svg>
	{/if}
	<form method="POST" action="?/setCover" enctype="multipart/form-data">
		{#if form?.action === 'cover' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		<div class="field">
			<label for="st-cover">Cover image</label>
			<input
				id="st-cover"
				class="input"
				type="file"
				name="cover"
				accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
				required
			/>
		</div>
		<div class="settings-actions">
			{#if form?.action === 'cover' && form.saved}
				<span class="field-hint" role="status" style="color:var(--status-final);">Cover saved.</span
				>
			{/if}
			<button class="btn btn-primary" type="submit">Upload cover</button>
		</div>
	</form>
</div>

<style>
	.cover {
		width: 120px;
		height: 180px;
		object-fit: cover;
		border-radius: 6px;
		display: block;
		margin-bottom: 12px;
	}
</style>
