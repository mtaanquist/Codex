<script lang="ts">
	import { resolve } from '$app/paths';
	import ExportPanel from '$lib/components/ExportPanel.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Export</h2>
	<p class="admin-block-sub">Take your words with you; nothing is trapped here.</p>
</div>
<div class="settings-group">
	<ExportPanel
		scope="story"
		targetId={data.story.id}
		formats={[
			{ format: 'zip', label: 'markdown (.zip)' },
			{ format: 'epub', label: 'EPUB' }
		]}
		exports={data.exports}
		assetsConfigured={data.assetsConfigured}
	/>
	<p class="field-hint">
		Markdown bundles every scene and story note as a file with images; EPUB is for e-readers. For a
		PDF,
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (print view) -->
		<a href={`${resolve('/stories/[id]', { id: data.story.slug })}/print`}>open the print view</a>
		and choose "Save as PDF".
	</p>
</div>
