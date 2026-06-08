<script lang="ts">
	import { entityLetter } from '$lib/entity-color';
	import { badgeBackground, badgeImageSrc } from '$lib/entity-badge';

	// One entity badge: an uploaded image when set, otherwise the entity's
	// letter on its resolved colour. Shared by every badge site so the override
	// renders the same everywhere.
	let {
		name,
		badgeColor = null,
		badgeAssetId = null,
		categoryColor = null,
		size = 'dot',
		letter = true
	}: {
		name: string;
		badgeColor?: string | null;
		badgeAssetId?: string | null;
		categoryColor?: string | null;
		size?: 'dot' | 'sm' | 'lg';
		// Some tiny dots show colour only; the rest carry the entity's letter.
		letter?: boolean;
	} = $props();

	const image = $derived(badgeImageSrc({ badgeAssetId }));
	const background = $derived(badgeBackground({ name, badgeColor, categoryColor }));
</script>

{#if image}
	<span class="badge {size} badge-img"><img src={image} alt="" /></span>
{:else}
	<span class="badge {size}" style="background: {background}"
		>{letter ? entityLetter(name) : ''}</span
	>
{/if}
