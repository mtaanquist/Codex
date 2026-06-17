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
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The scene-break override needs a mode select, since a blank text value
	// is itself a meaningful choice (a plain gap). A full page load follows
	// every save, so the initial value is the current one.
	// svelte-ignore state_referenced_locally
	let sceneBreakMode = $state('sceneBreak' in data.pageSetupOverrides ? 'custom' : '');
	// Page-setup selects that reveal a companion input; '' means the story
	// inherits the account setting.
	// svelte-ignore state_referenced_locally
	let stFont = $state((data.pageSetupOverrides.font as string) ?? '');
	// svelte-ignore state_referenced_locally
	let stLineSpacing = $state((data.pageSetupOverrides.lineSpacing as string) ?? '');
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Page setup</h2>
	<p class="admin-block-sub">
		How this story's print and PDF output is typeset. Anything left on "Use my account setting"
		follows your account page.
	</p>
</div>
<div class="settings-group">
	<form
		method="POST"
		action="?/savePageSetup"
		use:enhance={autosaveSubmit}
		onchange={autosubmitForm}
	>
		{#if form?.action === 'pagesetup' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		<div class="field-grid">
			<div class="field">
				<label for="st-pagesize">Page size</label>
				<select
					id="st-pagesize"
					class="select"
					name="pageSize"
					value={(data.pageSetupOverrides.pageSize as string) ?? ''}
				>
					<option value="">
						Use my account setting ({PAGE_SIZES[data.accountPageSetup.pageSize].label})
					</option>
					{#each Object.entries(PAGE_SIZES) as [value, size] (value)}
						<option {value}>{size.label}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="st-margins">Margins</label>
				<select
					id="st-margins"
					class="select"
					name="margins"
					value={(data.pageSetupOverrides.margins as string) ?? ''}
				>
					<option value="">
						Use my account setting ({PAGE_MARGINS[data.accountPageSetup.margins].label})
					</option>
					{#each Object.entries(PAGE_MARGINS) as [value, margin] (value)}
						<option {value}>{margin.label}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="st-font">Font</label>
				<select id="st-font" class="select" name="font" bind:value={stFont}>
					<option value="">
						Use my account setting ({PAGE_FONTS[data.accountPageSetup.font].label})
					</option>
					{#each Object.entries(PAGE_FONTS) as [value, font] (value)}
						<option {value}>{font.label}</option>
					{/each}
				</select>
				{#if stFont === 'custom'}
					<input
						class="input"
						type="text"
						name="fontCustom"
						maxlength="50"
						placeholder="Font name, e.g. Garamond"
						value={(data.pageSetupOverrides.fontCustom as string) ?? ''}
					/>
					<p class="field-hint">
						Type the name of a font installed on the reading device. If it is not found, the default
						font is used instead.
					</p>
				{/if}
			</div>
			<div class="field">
				<label for="st-fontsize">Font size</label>
				<select
					id="st-fontsize"
					class="select"
					name="fontSize"
					value={String(data.pageSetupOverrides.fontSize ?? '')}
				>
					<option value="">
						Use my account setting ({data.accountPageSetup.fontSize} pt)
					</option>
					{#each FONT_SIZES as size (size)}
						<option value={String(size)}>{size} pt</option>
					{/each}
				</select>
			</div>
		</div>
		<div class="field">
			<label for="st-paragraphs">Paragraphs</label>
			<select
				id="st-paragraphs"
				class="select"
				name="paragraphStyle"
				value={(data.pageSetupOverrides.paragraphStyle as string) ?? ''}
			>
				<option value="">
					Use my account setting ({data.accountPageSetup.paragraphStyle === 'spaced'
						? 'Space between paragraphs'
						: 'First-line indent'})
				</option>
				<option value="indent">First-line indent</option>
				<option value="spaced">Space between paragraphs</option>
			</select>
		</div>
		<div class="field">
			<label for="st-linespacing">Line spacing</label>
			<select id="st-linespacing" class="select" name="lineSpacing" bind:value={stLineSpacing}>
				<option value="">
					Use my account setting ({LINE_SPACINGS[data.accountPageSetup.lineSpacing].label})
				</option>
				{#each Object.entries(LINE_SPACINGS) as [value, option] (value)}
					<option {value}>{option.label}</option>
				{/each}
			</select>
			{#if stLineSpacing === 'custom'}
				<input
					class="input"
					type="number"
					name="lineSpacingCm"
					min={LINE_SPACING_CM_MIN}
					max={LINE_SPACING_CM_MAX}
					step="0.05"
					value={(data.pageSetupOverrides.lineSpacingCm as number) ?? ''}
				/>
				<p class="field-hint">
					The height of each line in centimetres, from {LINE_SPACING_CM_MIN} to {LINE_SPACING_CM_MAX}.
				</p>
			{/if}
		</div>
		<div class="field">
			<label for="st-align">Text alignment</label>
			<select
				id="st-align"
				class="select"
				name="textAlign"
				value={(data.pageSetupOverrides.textAlign as string) ?? ''}
			>
				<option value="">
					Use my account setting ({TEXT_ALIGNS[data.accountPageSetup.textAlign].label})
				</option>
				{#each Object.entries(TEXT_ALIGNS) as [value, option] (value)}
					<option {value}>{option.label}</option>
				{/each}
			</select>
		</div>
		<div class="field">
			<label for="st-gutter">Binding gutter</label>
			<select
				id="st-gutter"
				class="select"
				name="gutter"
				value={(data.pageSetupOverrides.gutter as string) ?? ''}
			>
				<option value="">
					Use my account setting ({GUTTERS[data.accountPageSetup.gutter].label})
				</option>
				{#each Object.entries(GUTTERS) as [value, option] (value)}
					<option {value}>{option.label}</option>
				{/each}
			</select>
			<span class="field-hint">Extra inner margin for the spine. PDF and print only.</span>
		</div>
		<div class="field">
			<label for="st-scenebreak">Scene break</label>
			<select id="st-scenebreak" class="select" name="sceneBreakMode" bind:value={sceneBreakMode}>
				<option value="">
					Use my account setting ({data.accountPageSetup.sceneBreak || 'plain gap'})
				</option>
				<option value="custom">Set for this story</option>
			</select>
		</div>
		{#if sceneBreakMode === 'custom'}
			<div class="field">
				<label for="st-scenebreak-text">Scene break text</label>
				<input
					id="st-scenebreak-text"
					class="input"
					type="text"
					name="sceneBreak"
					maxlength="20"
					value={(data.pageSetupOverrides.sceneBreak as string) ?? ''}
				/>
				<p class="field-hint">The text printed between scenes. Leave blank for a plain gap.</p>
			</div>
		{/if}
		<div class="field-grid">
			<div class="field">
				<label for="st-pagenumbers">Page numbers (PDF downloads only)</label>
				<select
					id="st-pagenumbers"
					class="select"
					name="pageNumbers"
					value={data.pageSetupOverrides.pageNumbers === undefined
						? ''
						: data.pageSetupOverrides.pageNumbers
							? 'on'
							: 'off'}
				>
					<option value="">
						Use my account setting ({data.accountPageSetup.pageNumbers ? 'On' : 'Off'})
					</option>
					<option value="on">On</option>
					<option value="off">Off</option>
				</select>
			</div>
			<div class="field">
				<label for="st-runninghead">Story title at the top of each page (PDF downloads only)</label>
				<select
					id="st-runninghead"
					class="select"
					name="runningHeader"
					value={data.pageSetupOverrides.runningHeader === undefined
						? ''
						: data.pageSetupOverrides.runningHeader
							? 'on'
							: 'off'}
				>
					<option value="">
						Use my account setting ({data.accountPageSetup.runningHeader ? 'On' : 'Off'})
					</option>
					<option value="on">On</option>
					<option value="off">Off</option>
				</select>
			</div>
		</div>
		<div class="settings-actions">
			{#if form?.action === 'pagesetup' && form.saved}
				<span class="field-hint" role="status" style="color:var(--status-final);">Saved.</span>
			{/if}
		</div>
	</form>
</div>
