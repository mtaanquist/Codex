<script lang="ts">
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit, autosubmitForm } from '#lib/autosave-form';
	import { resolveRoleModel, type AssistantRole } from '#lib/assistant-tuning';
	import { ROLE_META } from '#lib/assistant-roles';
	import FormStatus from './FormStatus.svelte';

	// The Assistant model pickers on a universe's or a story's settings page:
	// one per kind of work, each defaulting to the level above. Saves on change
	// through the page's saveAssistantModels action.
	type Models = Partial<Record<AssistantRole, string>>;
	let {
		level,
		settings,
		modelsQuery,
		error = null,
		saved = false
	}: {
		level: 'universe' | 'story';
		settings: { saved: Models; inherited: Models; suggested: Record<AssistantRole, string> };
		// The query for /api/assistant/models that names this universe or story.
		modelsQuery: string;
		error?: string | null;
		saved?: boolean;
	} = $props();

	// The form owns the picks once shown; the page reloads its data after a save.
	// svelte-ignore state_referenced_locally
	let picks = $state<Models>({ ...settings.saved });

	// What the endpoint lists. A listing that fails still leaves the models
	// already chosen somewhere, so a pick is never dropped from its own list.
	let listed = $state<string[]>([]);
	let complete = $state(true);
	$effect(() => {
		const controller = new AbortController();
		fetch(`/api/assistant/models?${modelsQuery}`, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error('failed');
				const body = (await response.json()) as { models: string[]; complete: boolean };
				listed = body.models;
				complete = body.complete;
			})
			.catch(() => {
				if (!controller.signal.aborted) complete = false;
			});
		return () => controller.abort();
	});
	const options = $derived(
		[
			...new Set([
				...listed,
				...Object.values(settings.inherited),
				...Object.values(settings.saved),
				...Object.values(picks)
			])
		]
			.filter((model): model is string => !!model)
			.sort((a, b) => a.localeCompare(b))
	);

	// What a role runs on with nothing picked for it here: the level above, or
	// this level's Rubber duck model when the levels above pick none for it.
	function defaultModel(role: AssistantRole): string {
		const others = { ...picks };
		delete others[role];
		return resolveRoleModel({ ...settings.inherited, ...others }, role, settings.suggested[role]);
	}
	const above = $derived(level === 'story' ? 'the universe or your account' : 'your account');
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Assistant models</h2>
	<p class="admin-block-sub">
		{#if level === 'universe'}
			Choose a model for each kind of work in this universe. A story can choose its own in its
			settings.
		{:else}
			Choose a model for each kind of work in this story.
		{/if}
		Leave a row on "Default" to use the model from {above}.
	</p>
</div>
<div class="settings-group">
	<form
		method="POST"
		action="?/saveAssistantModels"
		use:enhance={autosaveSubmit}
		onchange={autosubmitForm}
	>
		<div class="role-table">
			{#each ROLE_META as role (role.id)}
				<div class="role-row">
					<div class="role-row-label">
						<label class="role-row-name" for="scope-model-{role.id}">{role.name}</label>
						<div class="role-row-hint">{role.hint}</div>
					</div>
					<div class="role-row-controls">
						<select
							class="select"
							id="scope-model-{role.id}"
							name={role.id}
							bind:value={
								() => picks[role.id] ?? '',
								(value) => {
									if (value) picks[role.id] = value;
									else delete picks[role.id];
								}
							}
						>
							<option value="">
								{defaultModel(role.id) ? `Default: ${defaultModel(role.id)}` : 'Default'}
							</option>
							{#each options as model (model)}
								<option value={model}>{model}</option>
							{/each}
						</select>
					</div>
				</div>
			{/each}
		</div>
		{#if !complete}
			<p class="field-hint">
				The full list of models could not be loaded, so only the ones already chosen are shown.
				Check the endpoint on your account page, then reload this page.
			</p>
		{/if}
		<div class="settings-actions">
			<FormStatus {error} success={saved ? 'Saved.' : null} />
		</div>
	</form>
</div>
