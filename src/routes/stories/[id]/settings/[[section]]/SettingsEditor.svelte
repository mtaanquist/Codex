<script lang="ts">
	import { enhance } from '$app/forms';
	import { autosaveSubmit, autosubmitForm } from '$lib/autosave-form';
	import { WRITING_LANGUAGES, writingLanguageLabel } from '$lib/writing-languages';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Mirrors the option labels on the account page's Editor behavior cards.
	const AUTOCOMPLETE_LABELS: Record<string, string> = {
		off: 'Off',
		ghost: 'Inline ghost-text',
		popup: 'Popup menu'
	};
	const MARKS_LABELS: Record<string, string> = {
		shown: 'Shown',
		hidden: 'Hidden'
	};
	const EDITING_LABELS: Record<string, string> = {
		markdown: 'Markdown',
		rich: 'Rich text'
	};
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Editor</h2>
	<p class="admin-block-sub">
		These apply to this story only. "Use my account setting" follows whatever is set on your account
		page, now and when you change it there.
	</p>
</div>
<div class="settings-group">
	<form
		method="POST"
		action="?/savePreferences"
		use:enhance={autosaveSubmit}
		onchange={autosubmitForm}
	>
		{#if form?.action === 'prefs' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		<div class="field">
			<label for="st-autocomplete">Entity autocomplete</label>
			<select
				id="st-autocomplete"
				class="select"
				name="entityAutocomplete"
				value={(data.preferenceOverrides.entityAutocomplete as string) ?? ''}
			>
				<option value="">
					Use my account setting ({AUTOCOMPLETE_LABELS[data.accountPreferences.entityAutocomplete]})
				</option>
				<option value="off">Off</option>
				<option value="ghost">Inline ghost-text</option>
				<option value="popup">Popup menu</option>
			</select>
		</div>
		<div class="field">
			<label for="st-editing">Editing mode</label>
			<select
				id="st-editing"
				class="select"
				name="editingMode"
				value={(data.preferenceOverrides.editingMode as string) ?? ''}
			>
				<option value="">
					Use my account setting ({EDITING_LABELS[data.accountPreferences.editingMode]})
				</option>
				<option value="markdown">Markdown</option>
				<option value="rich">Rich text</option>
			</select>
		</div>
		<div class="field">
			<label for="st-spell">Spell-check</label>
			<select
				id="st-spell"
				class="select"
				name="spellCheck"
				value={(data.preferenceOverrides.spellCheck as string) ?? ''}
			>
				<option value="">
					Use my account setting ({data.accountPreferences.spellCheck === 'on' ? 'On' : 'Off'})
				</option>
				<option value="on">On</option>
				<option value="off">Off</option>
			</select>
		</div>
		<div class="field">
			<label for="st-language">Writing language</label>
			<select
				id="st-language"
				class="select"
				name="writingLanguage"
				value={data.preferenceOverrides.writingLanguage === undefined
					? ''
					: data.preferenceOverrides.writingLanguage === ''
						? 'browser'
						: (data.preferenceOverrides.writingLanguage as string)}
			>
				<option value="">
					Use my account setting ({data.accountPreferences.writingLanguage
						? writingLanguageLabel(data.accountPreferences.writingLanguage)
						: 'Follow my browser'})
				</option>
				<option value="browser">Follow my browser</option>
				{#each WRITING_LANGUAGES as language (language.tag)}
					<option value={language.tag}>{language.label}</option>
				{/each}
			</select>
		</div>
		<div class="field">
			<label for="st-marks">Scene marks in the story view</label>
			<select
				id="st-marks"
				class="select"
				name="continuousSceneMarks"
				value={(data.preferenceOverrides.continuousSceneMarks as string) ?? ''}
			>
				<option value="">
					Use my account setting ({MARKS_LABELS[data.accountPreferences.continuousSceneMarks]})
				</option>
				<option value="shown">Shown</option>
				<option value="hidden">Hidden</option>
			</select>
		</div>
		<div class="settings-actions">
			{#if form?.action === 'prefs' && form.saved}
				<span class="field-hint" role="status" style="color:var(--status-final);">Saved.</span>
			{/if}
		</div>
	</form>
</div>
