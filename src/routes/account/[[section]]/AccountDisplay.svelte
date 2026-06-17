<script lang="ts">
	import { tick } from 'svelte';
	import { browser } from '$app/environment';
	import { enhance } from '$app/forms';
	import { autosaveSubmit, autosubmitForm } from '$lib/autosave-form';
	import { ACCENT_PRESETS, DARK_THEMES, LIGHT_THEMES } from '$lib/appearance';
	import { applyAppearance } from '$lib/appearance-apply';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const THEME_LABELS = { light: 'Light', warm: 'Warm', dark: 'Dark' } as const;

	// Appearance preview: local state seeded from the saved preferences, applied
	// live as the user edits. Saving persists it; the layout re-applies on load.
	// svelte-ignore state_referenced_locally
	let theme = $state(data.preferences.theme);
	// svelte-ignore state_referenced_locally
	let systemLightTheme = $state(data.preferences.systemLightTheme);
	// svelte-ignore state_referenced_locally
	let systemDarkTheme = $state(data.preferences.systemDarkTheme);
	// svelte-ignore state_referenced_locally
	let accent = $state(data.preferences.accent);
	$effect(() => {
		if (browser) applyAppearance(theme, accent, systemLightTheme, systemDarkTheme);
	});

	// The accent swatches set state rather than a form value, so saving waits a
	// tick for the hidden input to catch up before submitting the form.
	let appearanceForm = $state<HTMLFormElement>();
	async function pickAccent(value: string) {
		accent = value;
		await tick();
		appearanceForm?.requestSubmit();
	}
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Display</h1>
	<p class="admin-lede">The colour theme and accent used across the app.</p>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Appearance</h2>
		<p class="admin-block-sub">The colour theme and accent used across the app.</p>
	</div>
	<div class="settings-group">
		<form
			method="POST"
			action="?/saveAppearance"
			bind:this={appearanceForm}
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<div class="field">
				<label for="theme-pref">Theme</label>
				<select id="theme-pref" class="select" name="theme" bind:value={theme}>
					<option value="system">Follow system</option>
					<option value="light">Light</option>
					<option value="warm">Warm</option>
					<option value="dark">Dark</option>
				</select>
			</div>

			{#if theme === 'system'}
				<div class="field">
					<label for="sys-light">When my system is light, use</label>
					<select
						id="sys-light"
						class="select"
						name="systemLightTheme"
						bind:value={systemLightTheme}
					>
						{#each LIGHT_THEMES as value (value)}
							<option {value}>{THEME_LABELS[value]}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label for="sys-dark">When my system is dark, use</label>
					<select id="sys-dark" class="select" name="systemDarkTheme" bind:value={systemDarkTheme}>
						{#each DARK_THEMES as value (value)}
							<option {value}>{THEME_LABELS[value]}</option>
						{/each}
					</select>
				</div>
			{/if}

			<div class="field" style="margin-bottom:0;">
				<!-- svelte-ignore a11y_label_has_associated_control -->
				<label id="accent-label">Accent colour</label>
				<input type="hidden" name="accent" value={accent} />
				<div class="swatch-row" role="radiogroup" aria-labelledby="accent-label">
					{#each ACCENT_PRESETS as preset (preset.value)}
						<button
							type="button"
							class="swatch"
							class:is-selected={accent === preset.value}
							style="background:{preset.value};"
							title={preset.name}
							role="radio"
							aria-checked={accent === preset.value}
							aria-label={preset.name}
							onclick={() => pickAccent(preset.value)}
						>
							<svg
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								stroke-width="2.4"
								stroke-linecap="round"
								stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg
							>
						</button>
					{/each}
					<span class="swatch-sep"></span>
					<label class="swatch-custom" title="Pick a custom colour">
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.2"
							stroke-linecap="round"
							stroke-linejoin="round"
							><path d="M19 3a2.83 2.83 0 0 0-4 0l-2.5 2.5" /><path d="m11 7 6 6" /><path
								d="M16 12 6.5 21.5a2.12 2.12 0 0 1-3-3L13 9"
							/></svg
						>
						<input type="color" bind:value={accent} aria-label="Custom accent colour" />
					</label>
				</div>
				<p class="field-hint">
					Tints buttons, links, and highlights. Pick a preset, or choose any colour.
				</p>
			</div>

			<div class="settings-actions">
				<FormStatus
					error={form?.scope === 'appearance' && form.message ? form.message : null}
					success={form?.scope === 'appearance' && form.saved ? 'Saved.' : null}
				/>
			</div>
		</form>
	</div>
</div>
