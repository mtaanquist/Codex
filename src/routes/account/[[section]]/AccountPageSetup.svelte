<script lang="ts">
	import { enhance } from '$app/forms';
	import { autosaveSubmit, autosubmitForm } from '$lib/autosave-form';
	import {
		FONT_SIZES,
		GUTTERS,
		LINE_SPACING_CM_MAX,
		LINE_SPACING_CM_MIN,
		LINE_SPACINGS,
		PAGE_FONTS,
		PAGE_MARGINS,
		PAGE_SIZES,
		TEXT_ALIGNS
	} from '$lib/page-setup';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Selects that reveal a companion input: the custom font name and the custom
	// line spacing in centimetres.
	// svelte-ignore state_referenced_locally
	let psFont = $state(data.pageSetup.font);
	// svelte-ignore state_referenced_locally
	let psLineSpacing = $state(data.pageSetup.lineSpacing);
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Page setup</h1>
	<p class="admin-lede">
		How print and PDF output is typeset. These are your defaults; a story can override them in its
		own settings.
	</p>
</div>

<div class="admin-block">
	<div class="settings-group">
		<form
			method="POST"
			action="?/savePageSetup"
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<div class="field">
				<label for="ps-size">Page size</label>
				<select id="ps-size" class="select" name="pageSize" value={data.pageSetup.pageSize}>
					{#each Object.entries(PAGE_SIZES) as [value, size] (value)}
						<option {value}>{size.label}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="ps-margins">Margins</label>
				<select id="ps-margins" class="select" name="margins" value={data.pageSetup.margins}>
					{#each Object.entries(PAGE_MARGINS) as [value, margin] (value)}
						<option {value}>{margin.label}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="ps-font">Font</label>
				<select id="ps-font" class="select" name="font" bind:value={psFont}>
					{#each Object.entries(PAGE_FONTS) as [value, font] (value)}
						<option {value}>{font.label}</option>
					{/each}
				</select>
				{#if psFont === 'custom'}
					<input
						class="input"
						type="text"
						name="fontCustom"
						maxlength="50"
						placeholder="Font name, e.g. Garamond"
						value={data.pageSetup.fontCustom}
					/>
					<p class="field-hint">
						Type the name of a font installed on the reading device. If it is not found, the default
						font is used instead.
					</p>
				{/if}
			</div>
			<div class="field">
				<label for="ps-fontsize">Font size</label>
				<select
					id="ps-fontsize"
					class="select"
					name="fontSize"
					value={String(data.pageSetup.fontSize)}
				>
					{#each FONT_SIZES as size (size)}
						<option value={String(size)}>{size} pt</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="ps-paragraphs">Paragraphs</label>
				<select
					id="ps-paragraphs"
					class="select"
					name="paragraphStyle"
					value={data.pageSetup.paragraphStyle}
				>
					<option value="indent">First-line indent</option>
					<option value="spaced">Space between paragraphs</option>
				</select>
			</div>
			<div class="field">
				<label for="ps-linespacing">Line spacing</label>
				<select id="ps-linespacing" class="select" name="lineSpacing" bind:value={psLineSpacing}>
					{#each Object.entries(LINE_SPACINGS) as [value, option] (value)}
						<option {value}>{option.label}</option>
					{/each}
				</select>
				{#if psLineSpacing === 'custom'}
					<input
						class="input"
						type="number"
						name="lineSpacingCm"
						min={LINE_SPACING_CM_MIN}
						max={LINE_SPACING_CM_MAX}
						step="0.05"
						value={data.pageSetup.lineSpacingCm}
					/>
					<p class="field-hint">
						The height of each line in centimetres, from {LINE_SPACING_CM_MIN} to {LINE_SPACING_CM_MAX}.
					</p>
				{/if}
			</div>
			<div class="field">
				<label for="ps-align">Text alignment</label>
				<select id="ps-align" class="select" name="textAlign" value={data.pageSetup.textAlign}>
					{#each Object.entries(TEXT_ALIGNS) as [value, option] (value)}
						<option {value}>{option.label}</option>
					{/each}
				</select>
				<p class="field-hint">The alignment of paragraphs without their own alignment marker.</p>
			</div>
			<div class="field">
				<label for="ps-gutter">Binding gutter</label>
				<select id="ps-gutter" class="select" name="gutter" value={data.pageSetup.gutter}>
					{#each Object.entries(GUTTERS) as [value, option] (value)}
						<option {value}>{option.label}</option>
					{/each}
				</select>
				<span class="field-hint">Extra inner margin for the spine. PDF and print only.</span>
			</div>
			<div class="field">
				<label for="ps-scenebreak">Scene break</label>
				<input
					id="ps-scenebreak"
					class="input"
					type="text"
					name="sceneBreak"
					maxlength="20"
					value={data.pageSetup.sceneBreak}
				/>
				<p class="field-hint">The text printed between scenes. Leave blank for a plain gap.</p>
			</div>
			<div class="field">
				<label class="check-row">
					<input type="checkbox" name="pageNumbers" checked={data.pageSetup.pageNumbers} />
					Page numbers (PDF downloads only)
				</label>
				<label class="check-row">
					<input type="checkbox" name="runningHeader" checked={data.pageSetup.runningHeader} />
					Story title at the top of each page (PDF downloads only)
				</label>
			</div>
			<div class="settings-actions">
				<FormStatus
					error={form?.scope === 'pagesetup' && form.message ? form.message : null}
					success={form?.scope === 'pagesetup' && form.saved ? 'Saved.' : null}
				/>
			</div>
		</form>
	</div>
</div>
