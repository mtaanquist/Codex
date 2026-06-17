<script lang="ts">
	import type { PageData } from './$types';

	let { idPrefix, view }: { idPrefix: string; view: PageData['assetStorage'] } = $props();
</script>

<div class="field-grid">
	<div class="field">
		<label for="{idPrefix}-endpoint">Endpoint</label>
		<input
			id="{idPrefix}-endpoint"
			class="input"
			type="text"
			name="endpoint"
			value={view.endpoint}
			placeholder="https://s3.us-west-004.backblazeb2.com"
		/>
	</div>
	<div class="field">
		<label for="{idPrefix}-region">Region</label>
		<input
			id="{idPrefix}-region"
			class="input"
			type="text"
			name="region"
			value={view.region}
			placeholder="auto"
		/>
	</div>
</div>
<div class="field-grid">
	<div class="field">
		<label for="{idPrefix}-bucket">Bucket</label>
		<input id="{idPrefix}-bucket" class="input" type="text" name="bucket" value={view.bucket} />
	</div>
	<div class="field">
		<label for="{idPrefix}-prefix">Key prefix</label>
		<input id="{idPrefix}-prefix" class="input" type="text" name="prefix" value={view.prefix} />
	</div>
</div>
<div class="field">
	<label for="{idPrefix}-access">Access key id</label>
	<input
		id="{idPrefix}-access"
		class="input"
		type="text"
		name="accessKeyId"
		value={view.accessKeyId}
		autocomplete="off"
	/>
</div>
<div class="field">
	<label for="{idPrefix}-secret">Secret access key</label>
	<input
		id="{idPrefix}-secret"
		class="input"
		type="password"
		name="secretAccessKey"
		autocomplete="off"
		placeholder={view.hasSecret ? 'Leave blank to keep the current key' : ''}
	/>
</div>
