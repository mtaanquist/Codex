<script lang="ts">
	import Icon from './Icon.svelte';

	// Shown in a scene editor when its save was refused because the scene
	// changed somewhere else since this editor loaded it.
	let { onLoadNewer, onKeepMine }: { onLoadNewer: () => void; onKeepMine: () => void } = $props();
</script>

<div class="revision-banner" role="alert">
	<div class="revision-banner-icon"><Icon name="clock" size={16} /></div>
	<div class="revision-banner-main">
		<div class="revision-banner-title">This scene was changed in another window</div>
		<div class="revision-banner-sub">
			Your latest edits here are not saved yet. Load the newer version, or keep yours. Keeping yours
			puts the newer version in History.
		</div>
	</div>
	<div class="revision-banner-actions">
		<button class="btn btn-sm btn-secondary" type="button" onclick={onLoadNewer}>
			Load newer version
		</button>
		<button class="btn btn-sm btn-primary" type="button" onclick={onKeepMine}>Keep mine</button>
	</div>
</div>
