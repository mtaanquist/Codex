<script lang="ts">
	import { resolve } from '$app/paths';
	import { refreshAll } from '$app/navigation';
	import { CATEGORY_COLORS } from '$lib/entity-color';
	import { dismiss } from '$lib/dismiss';
	import EntityBadge from './EntityBadge.svelte';
	import FormStatus from './FormStatus.svelte';
	import { del, put, upload } from '$lib/api';

	// The entity badge and its little menu: palette swatches and the image
	// actions. Colour and image post straight to the badge endpoint (not the
	// debounced field save), then the page data refresh carries the change to
	// the sidebar and the rest.
	let {
		entityId,
		name,
		assetsConfigured = false,
		categoryColor = null,
		badgeColor: initialBadgeColor = null,
		badgeAssetId: initialBadgeAssetId = null
	}: {
		entityId: string;
		name: string;
		// Image uploads only appear when an asset bucket is configured.
		assetsConfigured?: boolean;
		// The category's colour, tinting the badge when no override is set.
		categoryColor?: string | null;
		badgeColor?: string | null;
		badgeAssetId?: string | null;
	} = $props();

	// The override lives here once set; seeded from the props and then driven by
	// the menu. The page keys the editor by entity id, so a fresh entity is a
	// fresh instance.
	// svelte-ignore state_referenced_locally
	let badgeColor = $state(initialBadgeColor);
	// svelte-ignore state_referenced_locally
	let badgeAssetId = $state(initialBadgeAssetId);
	let menuOpen = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let fileInput = $state<HTMLInputElement>();
	let dialogEl = $state<HTMLDivElement>();

	// Focus moves into the picker on open, onto the colour in effect.
	$effect(() => {
		dialogEl?.querySelector<HTMLElement>('.swatch.active, button, a')?.focus();
	});

	// A choice closes the picker; focus goes back to the badge.
	function closePicker() {
		menuOpen = false;
		trigger?.focus();
	}
	// A refused change reopens the menu with the reason, so it is not lost.
	let error = $state<string | null>(null);

	function fail(message: string) {
		error = message;
		menuOpen = true;
	}

	async function pickColour(color: string | null) {
		const previous = badgeColor;
		badgeColor = color;
		closePicker();
		error = null;
		const result = await put(
			`/api/entities/${entityId}/badge`,
			{ color },
			'Could not change the colour. Try again.'
		);
		if (!result.ok) {
			badgeColor = previous;
			fail(result.message);
			return;
		}
		await refreshAll();
	}

	async function uploadImage(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		closePicker();
		error = null;
		const data = new FormData();
		data.set('file', file);
		const result = await upload<{ id: string }>(
			`/api/entities/${entityId}/badge`,
			data,
			'Could not upload the image. Try again.'
		);
		if (!result.ok) return fail(result.message);
		badgeAssetId = result.id;
		await refreshAll();
	}

	async function removeImage() {
		closePicker();
		error = null;
		const result = await del(
			`/api/entities/${entityId}/badge`,
			'Could not remove the image. Try again.'
		);
		if (!result.ok) return fail(result.message);
		badgeAssetId = null;
		await refreshAll();
	}
</script>

<div
	class="badge-pick"
	use:dismiss={{
		enabled: menuOpen,
		close: () => (menuOpen = false),
		refocus: () => trigger?.focus()
	}}
>
	<button
		bind:this={trigger}
		class="badge-pick-btn"
		type="button"
		aria-haspopup="dialog"
		aria-expanded={menuOpen}
		title="Change the badge colour or image"
		aria-label="Change the badge colour or image"
		onclick={() => {
			menuOpen = !menuOpen;
			error = null;
		}}
	>
		<EntityBadge {name} {badgeColor} {badgeAssetId} {categoryColor} size="lg" />
	</button>
	{#if menuOpen}
		<div class="badge-menu" role="dialog" aria-label="Badge colour and image" bind:this={dialogEl}>
			{#if error}
				<div class="badge-error"><FormStatus block {error} /></div>
			{/if}
			{#if badgeAssetId}
				<a
					class="badge-menu-item"
					href={resolve('/assets/[id=uuid]', { id: badgeAssetId })}
					download
				>
					Download image
				</a>
				<button class="badge-menu-item" type="button" onclick={removeImage}> Remove image </button>
			{:else}
				<div class="badge-swatches">
					<button
						class="swatch swatch-default"
						class:active={!badgeColor}
						aria-pressed={!badgeColor}
						type="button"
						title="Default colour"
						aria-label="Default colour"
						onclick={() => pickColour(null)}
					></button>
					{#each CATEGORY_COLORS as choice (choice.token)}
						<button
							class="swatch"
							class:active={badgeColor === choice.token}
							aria-pressed={badgeColor === choice.token}
							type="button"
							style="background: {choice.token}"
							title={choice.label}
							aria-label={choice.label}
							onclick={() => pickColour(choice.token)}
						></button>
					{/each}
				</div>
				{#if assetsConfigured}
					<button class="badge-menu-item" type="button" onclick={() => fileInput?.click()}>
						Upload image
					</button>
					<input
						bind:this={fileInput}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
						onchange={uploadImage}
						hidden
					/>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	/* The badge picker: the large badge is a button that drops a small menu of
	   palette swatches and the image actions. */
	.badge-pick {
		position: relative;
		flex: none;
	}
	.badge-pick-btn {
		display: block;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		border-radius: 18px;
	}
	.badge-pick-btn:hover {
		opacity: 0.9;
	}
	.badge-menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 20;
		min-width: 184px;
		padding: 8px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
	}
	.badge-error {
		max-width: 220px;
	}
	.badge-error :global(.field-hint) {
		margin: 0 0 8px;
	}
	.badge-swatches {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 6px;
		margin-bottom: 6px;
	}
	.swatch {
		width: 22px;
		height: 22px;
		border-radius: 7px;
		border: 2px solid transparent;
		cursor: pointer;
		padding: 0;
	}
	.swatch.active {
		border-color: var(--text);
	}
	.swatch-default {
		background: linear-gradient(
			135deg,
			transparent calc(50% - 1px),
			var(--border-strong) calc(50% - 1px),
			var(--border-strong) calc(50% + 1px),
			transparent calc(50% + 1px)
		);
		box-shadow: inset 0 0 0 1px var(--border);
	}
	.badge-menu-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 7px 8px;
		border: 0;
		border-radius: 7px;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		text-decoration: none;
	}
	.badge-menu-item:hover {
		background: var(--bg-hover);
	}
</style>
