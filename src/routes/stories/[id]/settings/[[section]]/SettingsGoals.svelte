<script lang="ts">
	import { enhance } from '$app/forms';
	import { autosaveSubmit, autosubmitForm } from '$lib/autosave-form';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Goals</h2>
	<p class="admin-block-sub">
		An optional target length and a deadline for this story. Progress shows on the universe's
		Insights page.
	</p>
</div>
<div class="settings-group">
	<form method="POST" action="?/saveGoals" use:enhance={autosaveSubmit} onchange={autosubmitForm}>
		<div class="field-grid">
			<div class="field">
				<label for="goal-target">Target words (optional)</label>
				<input
					id="goal-target"
					class="input"
					type="number"
					name="targetWords"
					min="0"
					step="1000"
					value={data.story.targetWords ?? ''}
					placeholder="None"
				/>
			</div>
			<div class="field">
				<label for="goal-deadline">Deadline (optional)</label>
				<input
					id="goal-deadline"
					class="input"
					type="date"
					name="deadline"
					value={data.story.deadline ?? ''}
				/>
			</div>
		</div>
		<div class="settings-actions">
			{#if form?.action === 'goals' && form.message}
				<span class="field-hint" role="alert" style="color:var(--danger);">{form.message}</span>
			{:else if form?.action === 'goals' && form.saved}
				<span class="field-hint" role="status" style="color:var(--status-final);">Saved.</span>
			{/if}
		</div>
	</form>
</div>
