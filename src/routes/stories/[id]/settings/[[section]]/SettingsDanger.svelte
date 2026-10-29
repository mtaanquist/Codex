<script lang="ts">
	import { confirmSubmit } from '#lib/confirm.svelte';
	let { trashDays }: { trashDays: number } = $props();
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Danger zone</h2>
	<p class="admin-block-sub">
		Deleting a story takes its chapters, scenes, history, and reviews with it. The story sits in
		your library's deleted list for {trashDays} days, where you can restore it; after that it is deleted
		for good.
	</p>
</div>
<div class="settings-group">
	<form
		method="POST"
		action="?/delete"
		onsubmit={confirmSubmit({
			title: 'Delete this story?',
			body: `You can restore it from the library for ${trashDays} days.`,
			confirmLabel: 'Delete story',
			danger: true
		})}
	>
		<div class="settings-actions">
			<button type="submit" class="btn btn-danger">Delete story</button>
		</div>
	</form>
</div>
