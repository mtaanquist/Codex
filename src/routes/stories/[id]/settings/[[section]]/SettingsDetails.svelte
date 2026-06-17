<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
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
				<span class="field-hint" role="status" style="color:var(--status-final);">Saved.</span>
			{/if}
			<button class="btn btn-primary" type="submit">Save</button>
		</div>
	</form>
</div>
