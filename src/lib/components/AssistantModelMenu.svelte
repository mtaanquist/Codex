<script lang="ts" module>
	import type { EffortLevel } from '#lib/assistant-tuning';

	export const EFFORT_LABELS: Record<EffortLevel, string> = {
		low: 'Low',
		medium: 'Medium',
		high: 'High',
		xhigh: 'Extra high',
		max: 'Max'
	};
</script>

<script lang="ts">
	// The composer's model menu: the model and effort this chat runs on. The
	// list comes from the endpoint when the menu opens; "Default" clears the
	// chat's own choice so it follows the story or account setting again.
	import { EFFORT_LEVELS, modelTakesEffort } from '#lib/assistant-tuning';
	import { chatEffort, type ChatModelInfo, type ChatModelSettings } from '#lib/assistant-chat';
	import { menu } from '#lib/menu';
	import Icon from './Icon.svelte';

	let {
		info,
		settings,
		storyId = null,
		onChange,
		close,
		refocus
	}: {
		info: ChatModelInfo;
		// The story the panel is on, so models set for that story are offered.
		storyId?: string | null;
		settings: ChatModelSettings;
		onChange: (settings: ChatModelSettings) => void;
		close: () => void;
		refocus: () => void;
	} = $props();

	let models = $state<string[]>([]);
	let loading = $state(true);
	let complete = $state(true);

	$effect(() => {
		const controller = new AbortController();
		const query = storyId ? `?storyId=${encodeURIComponent(storyId)}` : '';
		fetch(`/api/assistant/models${query}`, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error('failed');
				const body = (await response.json()) as { models: string[]; complete: boolean };
				models = body.models;
				complete = body.complete;
			})
			.catch(() => {
				if (!controller.signal.aborted) complete = false;
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});

	const effort = $derived(chatEffort(settings, info));
	const showEffort = $derived(effort !== null);
	// The chat's own pick stays listed even when the endpoint no longer lists it.
	const choices = $derived(
		settings.model && !models.includes(settings.model) ? [settings.model, ...models] : models
	);

	function pickModel(id: string | undefined) {
		const next: ChatModelSettings = {};
		if (id) next.model = id;
		// Effort carries over only to a model that takes it.
		if (settings.effort && modelTakesEffort(id ?? info.model)) next.effort = settings.effort;
		onChange(next);
		close();
		refocus();
	}

	function pickEffort(level: EffortLevel) {
		onChange({ ...settings, effort: level });
	}
</script>

<div
	class="model-menu popover"
	role="menu"
	aria-label="Model for this chat"
	use:menu={{ close, refocus }}
>
	<div class="menu-heading">Model for this chat</div>
	<div class="model-list">
		<button
			class="menu-item model-row"
			type="button"
			role="menuitemradio"
			aria-checked={!settings.model}
			onclick={() => pickModel(undefined)}
		>
			<span class="model-name">Default</span>
			<span class="model-hint">{info.model || 'not set'}</span>
			{#if !settings.model}<Icon name="check" size={13} />{/if}
		</button>
		{#each choices as id (id)}
			<button
				class="menu-item model-row"
				type="button"
				role="menuitemradio"
				aria-checked={settings.model === id}
				onclick={() => pickModel(id)}
			>
				<span class="model-name">{id}</span>
				{#if settings.model === id}<Icon name="check" size={13} />{/if}
			</button>
		{/each}
		{#if loading}
			<p class="model-note">Loading models...</p>
		{:else if !complete}
			<p class="model-note">
				Could not list the models your endpoint offers. Check the endpoint on your account page.
			</p>
		{/if}
	</div>
	{#if showEffort}
		<div class="menu-heading">Effort</div>
		<div class="seg full effort-seg" role="group" aria-label="Effort">
			{#each EFFORT_LEVELS as level (level)}
				<button
					class="seg-btn"
					class:active={effort === level}
					type="button"
					role="menuitemradio"
					aria-checked={effort === level}
					onclick={() => pickEffort(level)}
				>
					{EFFORT_LABELS[level]}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.model-menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: min(400px, 60vh);
	}
	.menu-heading {
		padding: 6px 7px 3px;
		font-size: var(--text-micro);
		color: var(--text-faint);
	}
	.model-list {
		overflow-y: auto;
		min-height: 0;
	}
	.model-row {
		cursor: pointer;
	}
	.model-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.model-hint {
		flex: none;
		max-width: 55%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.model-note {
		margin: 6px 7px;
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.effort-seg {
		margin: 2px 4px 4px;
	}
	.effort-seg .seg-btn {
		font-size: var(--text-meta);
		padding-inline: 4px;
	}
</style>
