<script lang="ts">
	import { CATEGORY_COLORS, storyCoverColor } from '#lib/entity-color';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The select overrides it so the swatch previews the choice; it resets to
	// the stored colour whenever the story's data changes.
	let coverColor = $derived(storyCoverColor(data.story));
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Details</h2>
	<p class="admin-block-sub">The title and description readers and exports use.</p>
</div>
<div class="settings-group">
	<form method="POST" action="?/update">
		{#if form?.action === 'update' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		<div class="field">
			<label for="st-title">Title</label>
			<input
				id="st-title"
				class="input"
				type="text"
				name="title"
				value={data.story.title}
				required
			/>
			<span class="field-hint">
				The web address follows the title: /stories/{data.story.slug}. Renaming moves the address;
				the old one stops working.
			</span>
		</div>
		<div class="field">
			<label for="st-author">Author</label>
			<input
				id="st-author"
				class="input"
				type="text"
				name="author"
				value={data.story.author ?? ''}
			/>
		</div>
		<div class="field">
			<label for="st-brief">Brief</label>
			<input id="st-brief" class="input" type="text" name="brief" value={data.story.brief ?? ''} />
		</div>
		<div class="field">
			<label for="st-description">Description</label>
			<textarea id="st-description" class="input" name="description" rows="4"
				>{data.story.descriptionMd ?? ''}</textarea
			>
		</div>
		{#if !data.story.coverAssetId}
			<div class="field">
				<label for="st-cover-color">Cover colour</label>
				<div class="cover-color-row">
					<span class="cover-color-dot" style="background: {coverColor}"></span>
					<select id="st-cover-color" class="input" name="coverColor" bind:value={coverColor}>
						{#each CATEGORY_COLORS as choice (choice.token)}
							<option value={choice.token}>{choice.label}</option>
						{/each}
					</select>
				</div>
				<span class="field-hint">
					The colour of the cover in your library and on your public shelf. Uploading a cover image
					replaces it.
				</span>
			</div>
		{/if}
		<div class="field">
			<label for="st-style-notes">Genre and style</label>
			<textarea id="st-style-notes" class="input" name="styleNotes" rows="2"
				>{data.story.styleNotes ?? ''}</textarea
			>
			<p class="field-hint">
				A sentence on the genre and the style you are writing in, for example "epic fantasy serial,
				omniscient narrator, formal prose". The intended audience, the spelling you write in
				(British or American), and a comparison title or two also help. The Assistant reads this and
				judges the prose against it. Readers never see it.
			</p>
		</div>
		<div class="settings-actions">
			{#if form?.action === 'update' && form.saved}
				<span class="field-hint" role="status" style="color:var(--status-final-ink);">Saved.</span>
			{/if}
			<button class="btn btn-primary" type="submit">Save</button>
		</div>
	</form>
</div>

<style>
	.cover-color-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.cover-color-row .input {
		width: auto;
	}
	.cover-color-dot {
		width: 14px;
		height: 14px;
		border-radius: 99px;
		flex: none;
	}
</style>
