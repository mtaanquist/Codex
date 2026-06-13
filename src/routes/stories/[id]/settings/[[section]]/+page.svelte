<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import { autosaveSubmit, autosubmitForm, flushFocusedField } from '$lib/autosave-form';
	import { entityColor } from '$lib/entity-color';
	import HelpLink from '$lib/components/HelpLink.svelte';
	import ExportPanel from '$lib/components/ExportPanel.svelte';
	import PageTopBar from '$lib/components/PageTopBar.svelte';
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
	import { WRITING_LANGUAGES, writingLanguageLabel } from '$lib/writing-languages';
	import type { ActionData, PageData } from './$types';
	import { startBackgroundReview } from '$lib/assistant-actions';
	import { REVIEW_CATEGORIES } from '$lib/review-shape';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Each section is its own page (/settings/pagesetup, /settings/export, ...);
	// a plain /settings is the details. Forms post to the section they sit on.
	const active = $derived(page.params.section ?? 'details');

	// The help article that covers the open section; the rest fall back to
	// the general one.
	const HELP_BY_SECTION: Record<string, string> = {
		publish: 'publishing',
		cover: 'publishing',
		pagesetup: 'publishing',
		review: 'reviewing',
		editor: 'editor',
		goals: 'planning'
	};
	const helpTopic = $derived(HELP_BY_SECTION[active] ?? 'getting-started');

	function sectionHref(section: string): string {
		return resolve('/stories/[id]/settings/[[section]]', {
			id: data.story.slug,
			section: section === 'details' ? undefined : section
		});
	}

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

	// The settings forms (Editor, Page setup, Goals) save on change instead of
	// with a button; see $lib/autosave-form.
	beforeNavigate(flushFocusedField);

	const coverColor = $derived(entityColor(data.story.title));

	const FORMAT_LABELS: Record<string, string> = {
		markdown: 'Markdown (.zip)',
		epub: 'EPUB',
		pdf: 'PDF'
	};

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

	// Cover uploads need asset storage and publishing needs a public shelf;
	// without those the sections hide entirely rather than explaining server
	// configuration to a writer.
	const NAV = $derived(
		[
			{ id: 'details', label: 'Details' },
			{ id: 'editor', label: 'Editor' },
			{ id: 'pagesetup', label: 'Page setup' },
			{ id: 'goals', label: 'Goals' },
			{ id: 'cover', label: 'Cover' },
			{ id: 'publish', label: 'Publish' },
			{ id: 'review', label: 'Review' },
			{ id: 'export', label: 'Export' },
			{ id: 'history', label: 'History' },
			{ id: 'danger', label: 'Danger zone' }
		]
			.filter((item) => item.id !== 'cover' || data.assetsConfigured)
			.filter((item) => item.id !== 'publish' || (data.archive?.enabled && data.archive?.handle))
	);

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function inviteStatus(invitation: PageData['reviewInvitations'][number]): string {
		if (invitation.revokedAt) return 'Revoked';
		if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) return 'Expired';
		return 'Active';
	}

	let copiedReviewLink = $state(false);
	function copyReviewLink(path: string) {
		navigator.clipboard.writeText(`${location.origin}${path}`).then(() => {
			copiedReviewLink = true;
			setTimeout(() => (copiedReviewLink = false), 1500);
		});
	}

	// Queues a whole-story Assistant review (a background job) and tracks it in
	// the activity center; the owner is also notified when its notes land on the
	// review page. The story-level button runs the full copyedit: every scene
	// swept category by category, then one cross-scene consistency pass.
	let requestingReview = $state(false);
	async function reviewWholeStory() {
		if (requestingReview) return;
		requestingReview = true;
		try {
			await startBackgroundReview({
				storyId: data.story.id,
				categories: [...REVIEW_CATEGORIES],
				label: 'your story',
				reviewHref: `/stories/${data.story.slug}/review`
			});
		} finally {
			requestingReview = false;
		}
	}
</script>

<svelte:window onpagehide={flushFocusedField} />

<svelte:head>
	<title>{data.story.title} - Settings - Codex</title>
</svelte:head>

<div class="page-shell">
	<PageTopBar
		back={{ href: resolve('/stories/[id]', { id: data.story.slug }), label: data.story.title }}
		help={{ topic: helpTopic, label: 'story settings' }}
	/>

	<div class="admin-shell">
		<aside class="admin-sidebar">
			<div class="admin-sidebar-title">
				<span class="ic badge sm" style="background: {coverColor}; color: #fff;">
					{data.story.title.slice(0, 1).toUpperCase()}
				</span>
				<div>
					<div class="tt">{data.story.title}</div>
					<div class="st">{data.universe.name}</div>
				</div>
			</div>
			<!-- eslint-disable svelte/no-navigation-without-resolve (sectionHref wraps resolve) -->
			<nav class="admin-nav">
				<div class="admin-nav-label">Story settings</div>
				{#each NAV as item (item.id)}
					<a class="nav-item" class:active={active === item.id} href={sectionHref(item.id)}>
						{item.label}
					</a>
				{/each}
			</nav>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</aside>

		<main class="admin-main page-body">
			<div class="admin-main-inner">
				<div class="admin-head">
					<p class="admin-eyebrow">{data.universe.name}</p>
					<h1 class="admin-title">Story settings</h1>
					<p class="admin-lede">Everything about "{data.story.title}" that is not its prose.</p>
				</div>

				<div class="admin-block" class:active={active === 'details'} id="details">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Details</h2>
						<p class="admin-block-sub">The title and description readers and exports use.</p>
					</div>
					<div class="settings-group">
						<form method="POST" action="?/update">
							{#if form?.action === 'update' && form.message}
								<p class="form-error" role="alert">{form.message}</p>
							{/if}
							<div class="field">
								<label for="st-title">Title</label>
								<input
									id="st-title"
									class="input"
									type="text"
									name="title"
									value={data.story.title}
									required
								/>
								<span class="field-hint">
									The web address follows the title: /stories/{data.story.slug}. Renaming moves the
									address; the old one stops working.
								</span>
							</div>
							<div class="field">
								<label for="st-author">Author</label>
								<input
									id="st-author"
									class="input"
									type="text"
									name="author"
									value={data.story.author ?? ''}
								/>
							</div>
							<div class="field">
								<label for="st-brief">Brief</label>
								<input
									id="st-brief"
									class="input"
									type="text"
									name="brief"
									value={data.story.brief ?? ''}
								/>
							</div>
							<div class="field">
								<label for="st-description">Description</label>
								<textarea id="st-description" class="input" name="description" rows="4"
									>{data.story.descriptionMd ?? ''}</textarea
								>
							</div>
							<div class="field">
								<label for="st-style-notes">Genre and style</label>
								<textarea id="st-style-notes" class="input" name="styleNotes" rows="2"
									>{data.story.styleNotes ?? ''}</textarea
								>
								<p class="field-hint">
									A sentence on the genre and the style you are writing in, for example "epic
									fantasy serial, omniscient narrator, formal prose". The intended audience, the
									spelling you write in (British or American), and a comparison title or two also
									help. The Assistant reads this and judges the prose against it. Readers never see
									it.
								</p>
							</div>
							<div class="settings-actions">
								{#if form?.action === 'update' && form.saved}
									<span class="field-hint" role="status" style="color:var(--status-final);"
										>Saved.</span
									>
								{/if}
								<button class="btn btn-primary" type="submit">Save</button>
							</div>
						</form>
					</div>
				</div>

				<div class="admin-block" class:active={active === 'editor'} id="editor">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Editor</h2>
						<p class="admin-block-sub">
							These apply to this story only. "Use my account setting" follows whatever is set on
							your account page, now and when you change it there.
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
										Use my account setting ({AUTOCOMPLETE_LABELS[
											data.accountPreferences.entityAutocomplete
										]})
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
										Use my account setting ({data.accountPreferences.spellCheck === 'on'
											? 'On'
											: 'Off'})
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
										Use my account setting ({MARKS_LABELS[
											data.accountPreferences.continuousSceneMarks
										]})
									</option>
									<option value="shown">Shown</option>
									<option value="hidden">Hidden</option>
								</select>
							</div>
							<div class="settings-actions">
								{#if form?.action === 'prefs' && form.saved}
									<span class="field-hint" role="status" style="color:var(--status-final);"
										>Saved.</span
									>
								{/if}
							</div>
						</form>
					</div>
				</div>

				<div class="admin-block" class:active={active === 'pagesetup'} id="pagesetup">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Page setup</h2>
						<p class="admin-block-sub">
							How this story's print and PDF output is typeset. Anything left on "Use my account
							setting" follows your account page.
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
											Type the name of a font installed on the reading device. If it is not found,
											the default font is used instead.
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
								<select
									id="st-linespacing"
									class="select"
									name="lineSpacing"
									bind:value={stLineSpacing}
								>
									<option value="">
										Use my account setting ({LINE_SPACINGS[data.accountPageSetup.lineSpacing]
											.label})
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
								<span class="field-hint">Extra inner margin for the spine. PDF and print only.</span
								>
							</div>
							<div class="field">
								<label for="st-scenebreak">Scene break</label>
								<select
									id="st-scenebreak"
									class="select"
									name="sceneBreakMode"
									bind:value={sceneBreakMode}
								>
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
									<p class="field-hint">
										The text printed between scenes. Leave blank for a plain gap.
									</p>
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
									<label for="st-runninghead"
										>Story title at the top of each page (PDF downloads only)</label
									>
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
									<span class="field-hint" role="status" style="color:var(--status-final);"
										>Saved.</span
									>
								{/if}
							</div>
						</form>
					</div>
				</div>

				<div class="admin-block" class:active={active === 'goals'} id="goals">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Goals</h2>
						<p class="admin-block-sub">
							An optional target length and a deadline for this story. Progress shows on the
							universe's Insights page.
						</p>
					</div>
					<div class="settings-group">
						<form
							method="POST"
							action="?/saveGoals"
							use:enhance={autosaveSubmit}
							onchange={autosubmitForm}
						>
							<div class="field-grid">
								<div class="field">
									<label for="goal-target">Target words (optional)</label>
									<input
										id="goal-target"
										class="input"
										type="number"
										name="targetWords"
										min="0"
										step="1000"
										value={data.story.targetWords ?? ''}
										placeholder="None"
									/>
								</div>
								<div class="field">
									<label for="goal-deadline">Deadline (optional)</label>
									<input
										id="goal-deadline"
										class="input"
										type="date"
										name="deadline"
										value={data.story.deadline ?? ''}
									/>
								</div>
							</div>
							<div class="settings-actions">
								{#if form?.action === 'goals' && form.message}
									<span class="field-hint" role="alert" style="color:var(--danger);"
										>{form.message}</span
									>
								{:else if form?.action === 'goals' && form.saved}
									<span class="field-hint" role="status" style="color:var(--status-final);"
										>Saved.</span
									>
								{/if}
							</div>
						</form>
					</div>
				</div>

				{#if data.assetsConfigured}
					<div class="admin-block" class:active={active === 'cover'} id="cover">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Cover</h2>
							<p class="admin-block-sub">Shown on your public shelf and inside the EPUB.</p>
						</div>
						<div class="settings-group">
							{#if data.story.coverAssetId}
								<img class="cover" src="/assets/{data.story.coverAssetId}" alt="Story cover" />
							{:else}
								<svg class="cover" viewBox="0 0 200 300" role="img" aria-label="Default cover">
									<rect width="200" height="300" rx="6" style="fill: {coverColor}" />
									<text
										x="100"
										y="150"
										text-anchor="middle"
										fill="#fff"
										font-size="16"
										font-family="serif"
									>
										{data.story.title.slice(0, 18)}
									</text>
								</svg>
							{/if}
							<form method="POST" action="?/setCover" enctype="multipart/form-data">
								{#if form?.action === 'cover' && form.message}
									<p class="form-error" role="alert">{form.message}</p>
								{/if}
								<div class="field">
									<label for="st-cover">Cover image</label>
									<input
										id="st-cover"
										class="input"
										type="file"
										name="cover"
										accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
										required
									/>
								</div>
								<div class="settings-actions">
									{#if form?.action === 'cover' && form.saved}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Cover saved.</span
										>
									{/if}
									<button class="btn btn-primary" type="submit">Upload cover</button>
								</div>
							</form>
						</div>
					</div>
				{/if}

				{#if data.archive.enabled && data.archive.handle}
					<div class="admin-block" class:active={active === 'publish'} id="publish">
						<div class="admin-block-head">
							<h2 class="admin-block-title">
								Publish <HelpLink topic="publishing" label="publishing" />
							</h2>
							<p class="admin-block-sub">
								Who can find this story, and the frozen editions readers see.
							</p>
						</div>
						<div class="settings-group">
							<form method="POST" action="?/setVisibility">
								{#if form?.action === 'publish' && form.message}
									<p class="form-error" role="alert">{form.message}</p>
								{/if}
								{#if form?.action === 'publish' && 'saved' in form && form.saved}
									<p class="field-hint" role="status" style="color:var(--status-final);">Saved.</p>
								{/if}
								<div class="field">
									<label for="st-visibility">Visibility</label>
									<select
										id="st-visibility"
										class="select"
										name="visibility"
										value={data.story.visibility}
									>
										<option value="private">Private - not on your public pages</option>
										<option value="unlisted">Unlisted - direct link only</option>
										<option value="public">Public - listed on your shelf</option>
									</select>
								</div>
								<div class="field">
									<label class="check-row">
										<input type="checkbox" name="isAdult" checked={data.story.isAdult} />
										Adult content
									</label>
								</div>
								<div class="settings-actions">
									<button class="btn btn-primary" type="submit">Save visibility</button>
								</div>
							</form>
							<form method="POST" action="?/publish">
								{#if form?.action === 'publish' && 'published' in form && form.published}
									<p class="field-hint" role="status" style="color:var(--status-final);">
										Edition published. Readers see it at
										<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (public reader path) -->
										<a href="/@{data.archive.handle}/{data.story.id}">
											/@{data.archive.handle}/{data.story.id}
										</a>.
									</p>
								{/if}
								<div class="field">
									<label for="st-edition-label">Edition label (optional)</label>
									<input
										id="st-edition-label"
										class="input"
										type="text"
										name="versionLabel"
										placeholder="Edition 2"
									/>
									<p class="field-hint">
										Publishing freezes the story as it stands now. Later edits stay private until
										you publish again.
									</p>
								</div>
								<div class="settings-actions">
									<button class="btn btn-primary" type="submit">Publish edition</button>
								</div>
							</form>

							{#if data.edition && data.assetsConfigured}
								<div class="sub-head">Edition downloads</div>
								{#if form?.action === 'exports' && form.message}
									<p class="form-error" role="alert">{form.message}</p>
								{/if}
								{#if form?.action === 'exports' && 'queued' in form && form.queued}
									<p class="field-hint" role="status">
										Export run queued. The files appear below in a moment; reload to see them.
									</p>
								{/if}
								{#if form?.action === 'exports' && 'saved' in form && form.saved}
									<p class="field-hint" role="status" style="color:var(--status-final);">Saved.</p>
								{/if}
								{#if data.artifacts.length > 0}
									<ul class="exports">
										{#each data.artifacts as artifact (artifact.id)}
											<li>
												<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (file download) -->
												<a href="/artifacts/{artifact.id}" download>
													{FORMAT_LABELS[artifact.format] ?? artifact.format}
												</a>
												- {formatBytes(artifact.byteSize)}, generated {new Date(
													artifact.createdAt
												).toLocaleString()}
											</li>
										{/each}
									</ul>
								{:else}
									<p class="field-hint">
										The download files for this edition have not been generated yet. They are
										created shortly after publishing; if they do not appear, run the generation
										again.
									</p>
								{/if}
								{#if data.edition.artifactErrors.length > 0}
									<p class="field-hint" style="color:var(--danger);">
										Some downloads could not be built on the last run:
										{data.edition.artifactErrors
											.map((e) => `${e.format.toUpperCase()} (${e.error})`)
											.join(', ')}. A PDF needs the headless browser set up on the server; ask an
										administrator, then generate again.
									</p>
								{/if}
								<form method="POST" action="?/regenerateExports">
									<div class="settings-actions">
										<button class="btn" type="submit">Generate again</button>
									</div>
								</form>
								<form method="POST" action="?/setDownloads">
									<div class="field">
										<label class="check-row">
											<input
												type="checkbox"
												name="downloadsPublic"
												checked={data.edition.downloadsPublic}
											/>
											Let readers download this edition (EPUB and PDF) from its public page
										</label>
									</div>
									<div class="settings-actions">
										<button class="btn btn-primary" type="submit">Save</button>
									</div>
								</form>
							{/if}
						</div>
					</div>
				{/if}

				<div class="admin-block" class:active={active === 'review'} id="review">
					<div class="admin-block-head">
						<h2 class="admin-block-title">
							Review <HelpLink topic="reviewing" label="reviewing" />
						</h2>
						<p class="admin-block-sub">
							Invite someone to read this story and leave comments. They follow a link; no account
							is needed.
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (app path with a suffix) -->
							<a href={`${resolve('/stories/[id]', { id: data.story.slug })}/review`}>
								Open review mode</a
							> to read the manuscript and leave your own comments and suggestions, and to work through
							any feedback.
						</p>
					</div>
					{#if data.assistant.surfacesEnabled}
						<div class="settings-group">
							<p class="admin-block-sub" style="margin-top:0;">
								The Assistant can read the whole story and leave its own comments and suggested
								edits, alongside any from your reviewers. It runs in the background; you will be
								notified when its notes are ready on the review page.
							</p>
							<button
								type="button"
								class="btn btn-primary"
								onclick={reviewWholeStory}
								disabled={requestingReview}
							>
								{requestingReview ? 'Starting...' : 'Review this story with the Assistant'}
							</button>
						</div>
					{/if}
					<div class="settings-group">
						<form method="POST" action="?/createReviewInvite">
							{#if form?.action === 'review' && form.message}
								<p class="form-error" role="alert">{form.message}</p>
							{/if}
							<div class="field-grid">
								<div class="field">
									<label for="st-review-note">Who is this link for? (optional)</label>
									<input
										id="st-review-note"
										class="input"
										type="text"
										name="note"
										placeholder="e.g. Sam, my writing group"
									/>
								</div>
								<div class="field">
									<label for="st-review-expiry">Expires after (days)</label>
									<input
										id="st-review-expiry"
										class="input"
										type="number"
										name="expiresDays"
										min="1"
										max="365"
										placeholder="Never"
									/>
								</div>
							</div>
							<div class="field">
								<label class="check-row">
									<input type="checkbox" name="canSuggest" checked />
									Allow suggested edits (you accept or reject each one; comments are always allowed)
								</label>
							</div>
							<div class="settings-actions">
								<button class="btn btn-primary" type="submit">Create review link</button>
							</div>
						</form>
						{#if form?.action === 'review' && 'reviewLink' in form && form.reviewLink}
							<p role="status" class="review-link">
								Share this link; it is shown only once:
								<code>{form.reviewLink}</code>
								<button
									class="btn"
									type="button"
									onclick={() => copyReviewLink(form.reviewLink as string)}
								>
									{copiedReviewLink ? 'Copied' : 'Copy link'}
								</button>
							</p>
						{/if}
						{#if data.reviewInvitations.length > 0}
							<ul class="invitations">
								{#each data.reviewInvitations as invitation (invitation.id)}
									<li>
										<span>
											{invitation.email ?? 'Review link'} - {inviteStatus(invitation)}, created {new Date(
												invitation.createdAt
											).toLocaleDateString()}{invitation.guests.length > 0
												? ` - joined: ${invitation.guests.map((guest) => guest.displayName).join(', ')}`
												: ''}
										</span>
										{#if inviteStatus(invitation) === 'Active'}
											<form method="POST" action="?/revokeReviewInvite">
												<input type="hidden" name="invitationId" value={invitation.id} />
												<button type="submit" class="danger-ghost">Revoke</button>
											</form>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>

				<div class="admin-block" class:active={active === 'export'} id="export">
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
							Markdown bundles every scene and story note as a file with images; EPUB is for
							e-readers. For a PDF,
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (print view) -->
							<a href={`${resolve('/stories/[id]', { id: data.story.slug })}/print`}
								>open the print view</a
							>
							and choose "Save as PDF".
						</p>
					</div>
				</div>

				<div class="admin-block" class:active={active === 'history'} id="history">
					<div class="admin-block-head">
						<h2 class="admin-block-title">History</h2>
						<p class="admin-block-sub">Recent changes to this story's scenes and outline.</p>
					</div>
					<div class="settings-group">
						{#if data.timeline.length === 0}
							<p class="field-hint">
								Recent changes to this story's scenes and outline appear here.
							</p>
						{:else}
							<ul class="timeline">
								{#each data.timeline as row (row.id)}
									<li>
										<span class="t-name">{row.entityName ?? 'Untitled'}</span>
										<span class="t-what">
											{row.label ??
												(row.reason === 'checkpoint' ? 'checkpoint' : (row.reason ?? 'autosave'))}
										</span>
										<span class="t-when">{row.createdAt.toLocaleString()}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>

				<div class="admin-block danger-block" class:active={active === 'danger'} id="danger">
					<div class="admin-block-head">
						<h2 class="admin-block-title">Danger zone</h2>
						<p class="admin-block-sub">
							Deleting a story removes its chapters, scenes, history, and reviews. There is no undo.
						</p>
					</div>
					<div class="settings-group">
						<form method="POST" action="?/delete">
							<div class="settings-actions">
								<button type="submit" class="btn btn-danger">Delete story</button>
							</div>
						</form>
					</div>
				</div>
			</div>
		</main>
	</div>
</div>

<style>
	/* One section at a time; the URL picks which. */
	.admin-main .admin-block:not(.active) {
		display: none;
	}

	.cover {
		width: 120px;
		height: 180px;
		object-fit: cover;
		border-radius: 6px;
		display: block;
		margin-bottom: 12px;
	}
	.sub-head {
		font-size: 12.5px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 18px 0 10px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}
	.exports {
		list-style: none;
		padding: 0;
		margin: 0 0 10px;
		font-size: 13.5px;
	}
	.exports li {
		padding: 5px 0;
		color: var(--text-muted);
	}
	.exports a {
		color: var(--text);
		font-weight: 600;
	}
	.timeline {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.timeline li {
		display: flex;
		gap: 10px;
		align-items: baseline;
		padding: 6px 0;
		border-bottom: 1px dashed var(--border);
		font-size: 13px;
	}
	.t-name {
		font-weight: 600;
	}
	.t-what {
		color: var(--text-muted);
	}
	.t-when {
		margin-left: auto;
		color: var(--text-faint);
		font-size: 12px;
	}
	.review-link {
		font-size: 13.5px;
	}
	.review-link code {
		word-break: break-all;
	}
	.invitations {
		list-style: none;
		padding: 0;
		margin: 10px 0 0;
		font-size: 13.5px;
	}
	.invitations li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
		border-top: 1px dashed var(--border);
	}
	.invitations form {
		margin-left: auto;
	}
	.danger-ghost {
		background: transparent;
		border: 0;
		color: var(--danger, #b00020);
		cursor: pointer;
		padding: 0;
		font-size: 12.5px;
	}
	.danger-block {
		border-color: color-mix(in oklab, var(--danger, #b00020) 35%, var(--border));
	}
	/* Anchor nav items reuse the admin nav button styling. */
	.admin-nav a.nav-item {
		text-decoration: none;
		display: flex;
		align-items: center;
	}
</style>
