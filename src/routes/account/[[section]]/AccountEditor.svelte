<script lang="ts">
	import { enhance } from '$app/forms';
	import { autosaveSubmit, autosubmitForm } from '$lib/autosave-form';
	import {
		LINE_SPACING_CM_MAX,
		LINE_SPACING_CM_MIN,
		LINE_SPACINGS,
		PAGE_FONTS
	} from '$lib/page-setup';
	import { WRITING_LANGUAGES } from '$lib/writing-languages';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Page-setup-style selects that reveal a companion input: the custom font
	// name and the custom line spacing in centimetres.
	// svelte-ignore state_referenced_locally
	let edFont = $state(data.preferences.editorFont);
	// svelte-ignore state_referenced_locally
	let edLineSpacing = $state(data.preferences.editorLineSpacing);
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Editor</h1>
	<p class="admin-lede">How the writing area looks, and how the editor helps while you type.</p>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Writing appearance</h2>
		<p class="admin-block-sub">
			The font and line spacing of the writing area. This is separate from page setup, which is how
			exports are typeset.
		</p>
	</div>
	<div class="settings-group">
		<form
			method="POST"
			action="?/saveEditorAppearance"
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<div class="field">
				<label for="ed-font">Font</label>
				<select id="ed-font" class="select" name="editorFont" bind:value={edFont}>
					{#each Object.entries(PAGE_FONTS) as [value, font] (value)}
						<option {value}>{font.label}</option>
					{/each}
				</select>
				{#if edFont === 'custom'}
					<input
						class="input"
						type="text"
						name="editorFontCustom"
						maxlength="50"
						placeholder="Font name, e.g. Garamond"
						value={data.preferences.editorFontCustom}
					/>
					<p class="field-hint">
						Type the name of a font installed on this device. If it is not found, the default
						writing font is used instead.
					</p>
				{/if}
			</div>
			<div class="field">
				<label for="ed-linespacing">Line spacing</label>
				<select
					id="ed-linespacing"
					class="select"
					name="editorLineSpacing"
					bind:value={edLineSpacing}
				>
					{#each Object.entries(LINE_SPACINGS) as [value, option] (value)}
						<option {value}>{option.label}</option>
					{/each}
				</select>
				{#if edLineSpacing === 'custom'}
					<input
						class="input"
						type="number"
						name="editorLineSpacingCm"
						min={LINE_SPACING_CM_MIN}
						max={LINE_SPACING_CM_MAX}
						step="0.05"
						value={data.preferences.editorLineSpacingCm}
					/>
					<p class="field-hint">
						The height of each line in centimetres, from {LINE_SPACING_CM_MIN} to {LINE_SPACING_CM_MAX}.
					</p>
				{/if}
			</div>
			<div class="settings-actions">
				<FormStatus
					error={form?.scope === 'editorappearance' && form.message ? form.message : null}
					success={form?.scope === 'editorappearance' && form.saved ? 'Saved.' : null}
				/>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Editor behavior</h2>
		<p class="admin-block-sub">How the editor helps while you type.</p>
	</div>
	<div class="settings-group">
		<form
			method="POST"
			action="?/savePreferences"
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Entity autocomplete</span>
					<select
						class="select"
						name="entityAutocomplete"
						aria-label="Entity autocomplete"
						value={data.preferences.entityAutocomplete}
					>
						<option value="off">Off</option>
						<option value="ghost">Inline ghost-text</option>
						<option value="popup">Popup menu</option>
					</select>
				</div>
				<div class="behavior-body">
					How the editor suggests completions when you start typing a name it already knows.
					<ul>
						<li>
							<strong style="color:var(--text);font-weight:600;">Inline ghost-text.</strong>
							The completion appears as faded text after your cursor; press <kbd>Tab</kbd> to accept.
						</li>
						<li>
							<strong style="color:var(--text);font-weight:600;">Popup menu.</strong> A small
							dropdown with all matches; arrow keys to choose, <kbd>Enter</kbd> to accept.
						</li>
					</ul>
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Editing mode</span>
					<select
						class="select"
						name="editingMode"
						aria-label="Editing mode"
						value={data.preferences.editingMode}
					>
						<option value="markdown">Markdown</option>
						<option value="rich">Rich text</option>
					</select>
				</div>
				<div class="behavior-body">
					How prose looks while you write. Your work is stored as markdown either way.
					<ul>
						<li>
							<strong style="color:var(--text);font-weight:600;">Markdown.</strong> Formatting marks like
							** and # stay visible as you type, styled in place.
						</li>
						<li>
							<strong style="color:var(--text);font-weight:600;">Rich text.</strong> The marks hide except
							on the line you are editing, so the page reads like formatted text.
						</li>
					</ul>
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Non-printing characters</span>
					<select
						class="select"
						name="nonPrintingMarks"
						aria-label="Non-printing characters"
						value={data.preferences.nonPrintingMarks}
					>
						<option value="hidden">Hidden</option>
						<option value="shown">Shown</option>
					</select>
				</div>
				<div class="behavior-body">
					Show spaces, paragraph breaks, and soft line breaks as faint marks. You can also toggle
					this from the button on the editor's formatting bar.
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Command markers</span>
					<select
						class="select"
						name="commandMarkers"
						aria-label="Command markers"
						value={data.preferences.commandMarkers}
					>
						<option value="shown">Shown</option>
						<option value="hidden">Hidden</option>
					</select>
				</div>
				<div class="behavior-body">
					The alignment markers (\center, \right, \justify) that ride in the text. Hidden tucks them
					away except on the line you are editing, so the page reads as the finished alignment. You
					can also toggle this from the editor's formatting bar.
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Spell-check</span>
					<select
						class="select"
						name="spellCheck"
						aria-label="Spell-check"
						value={data.preferences.spellCheck}
					>
						<option value="on">On</option>
						<option value="off">Off</option>
					</select>
				</div>
				<div class="behavior-body">
					The browser's spell-checker underlines possible misspellings while you write.
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Writing language</span>
					<select
						class="select"
						name="writingLanguage"
						aria-label="Writing language"
						value={data.preferences.writingLanguage}
					>
						<option value="">Follow my browser</option>
						{#each WRITING_LANGUAGES as language (language.tag)}
							<option value={language.tag}>{language.label}</option>
						{/each}
					</select>
				</div>
				<div class="behavior-body">
					The language your prose is written in; spell-check uses its dictionary.
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Scene marks in the story view</span>
					<select
						class="select"
						name="continuousSceneMarks"
						aria-label="Scene marks in the story view"
						value={data.preferences.continuousSceneMarks}
					>
						<option value="shown">Shown</option>
						<option value="hidden">Hidden</option>
					</select>
				</div>
				<div class="behavior-body">
					Whether the continuous story view shows a divider and label between scenes, or reads as
					one uninterrupted manuscript.
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Writing streak</span>
					<select
						class="select"
						name="sessionStreak"
						aria-label="Writing streak"
						value={data.preferences.sessionStreak}
					>
						<option value="shown">Shown</option>
						<option value="hidden">Hidden</option>
					</select>
				</div>
				<div class="behavior-body">
					The Session tab's streak card: the week's writing days and the run you are on. Hide it if
					the scorekeeping is not for you.
				</div>
			</div>
			<div class="behavior-card">
				<div class="behavior-head">
					<span class="behavior-title">Daily word goal</span>
					<input
						class="select"
						type="number"
						name="dailyWordGoal"
						min="0"
						step="50"
						aria-label="Daily word goal"
						value={data.preferences.dailyWordGoal || ''}
						placeholder="None"
					/>
				</div>
				<div class="behavior-body">
					A daily word target. The Session tab and Insights show progress toward it. Leave it blank
					or zero for no goal.
				</div>
			</div>
			<div class="settings-actions">
				<FormStatus
					error={form?.scope === 'prefs' && form.message ? form.message : null}
					success={form?.scope === 'prefs' && form.saved ? 'Saved.' : null}
				/>
			</div>
		</form>
	</div>
</div>
