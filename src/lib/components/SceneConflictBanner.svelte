<script lang="ts">
	import Icon from './Icon.svelte';

	// Shown in a scene editor when its save was refused because the scene
	// changed somewhere else since this editor loaded it. paused: the page is
	// saving and swapping the scene, so neither choice can apply yet.
	let {
		onLoadNewer,
		onKeepMine,
		paused = false
	}: { onLoadNewer: () => void; onKeepMine: () => void; paused?: boolean } = $props();
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
		<button class="btn btn-sm btn-secondary" type="button" disabled={paused} onclick={onLoadNewer}>
			Load newer version
		</button>
		<button class="btn btn-sm btn-primary" type="button" disabled={paused} onclick={onKeepMine}
			>Keep mine</button
		>
	</div>
</div>
