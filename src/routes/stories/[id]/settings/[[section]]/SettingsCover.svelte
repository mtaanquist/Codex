<script lang="ts">
	import { storyCoverColor } from '#lib/entity-color';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const coverColor = $derived(storyCoverColor(data.story));
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Cover</h2>
	<p class="admin-block-sub">Shown on your public shelf and inside the EPUB.</p>
</div>
<div class="settings-group">
	{#if data.story.coverAssetId}
		<img class="cover" src="/assets/{data.story.coverAssetId}" alt="Story cover" />
	{:else}
		<!-- The same placeholder the library and public shelf draw. -->
		<span
			class="cover shelf-cover shelf-cover-tinted"
			style="--cover-tint: {coverColor}"
			role="img"
			aria-label="Default cover"
		>
			{data.story.title}
		</span>
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
				<span class="field-hint" role="status" style="color:var(--status-final-ink);"
					>Cover saved.</span
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
		border-radius: 6px;
		margin-bottom: 12px;
	}
	img.cover {
		display: block;
		object-fit: cover;
	}
	span.cover {
		font-size: 14px;
	}
</style>
