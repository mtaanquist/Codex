<script lang="ts">
	import { resolve } from '$app/paths';
	import { entityColor } from '$lib/entity-color';
	import HelpLink from '$lib/components/HelpLink.svelte';
	import { FONT_SIZES, PAGE_FONTS, PAGE_MARGINS, PAGE_SIZES } from '$lib/page-setup';
	import { WRITING_LANGUAGES, writingLanguageLabel } from '$lib/writing-languages';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The scene-break override needs a mode select, since a blank text value
	// is itself a meaningful choice (a plain gap). A full page load follows
	// every save, so the initial value is the current one.
	// svelte-ignore state_referenced_locally
	let sceneBreakMode = $state('sceneBreak' in data.pageSetupOverrides ? 'custom' : '');

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
</script>

<svelte:head>
	<title>{data.story.title} - Settings - Codex</title>
</svelte:head>

<main>
	<nav>
		<a href={resolve('/')}>Library</a> /
		<a href={resolve('/universes/[id]', { id: data.universe.id })}>{data.universe.name}</a> /
		<a href={resolve('/stories/[id]', { id: data.story.id })}>{data.story.title}</a>
	</nav>
	<h1>Story settings</h1>

	<form method="POST" action="?/update">
		{#if form?.action === 'update' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'update' && form.saved}
			<p role="status">Saved.</p>
		{/if}
		<label>
			Title
			<input type="text" name="title" value={data.story.title} required />
		</label>
		<label>
			Author
			<input type="text" name="author" value={data.story.author ?? ''} />
		</label>
		<label>
			Brief
			<input type="text" name="brief" value={data.story.brief ?? ''} />
		</label>
		<label>
			Description
			<textarea name="description" rows="4">{data.story.descriptionMd ?? ''}</textarea>
		</label>
		<button type="submit">Save</button>
	</form>

	<h2>Editor</h2>
	<p class="hint">
		These apply to this story only. "Use my account setting" follows whatever is set on your account
		page, now and when you change it there.
	</p>
	<form method="POST" action="?/savePreferences">
		{#if form?.action === 'prefs' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'prefs' && form.saved}
			<p role="status">Saved.</p>
		{/if}
		<label>
			Entity autocomplete
			<select
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
		</label>
		<label>
			Editing mode
			<select name="editingMode" value={(data.preferenceOverrides.editingMode as string) ?? ''}>
				<option value="">
					Use my account setting ({EDITING_LABELS[data.accountPreferences.editingMode]})
				</option>
				<option value="markdown">Markdown</option>
				<option value="rich">Rich text</option>
			</select>
		</label>
		<label>
			Spell-check
			<select name="spellCheck" value={(data.preferenceOverrides.spellCheck as string) ?? ''}>
				<option value="">
					Use my account setting ({data.accountPreferences.spellCheck === 'on' ? 'On' : 'Off'})
				</option>
				<option value="on">On</option>
				<option value="off">Off</option>
			</select>
		</label>
		<label>
			Writing language
			<select
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
		</label>
		<label>
			Scene marks in the story view
			<select
				name="continuousSceneMarks"
				value={(data.preferenceOverrides.continuousSceneMarks as string) ?? ''}
			>
				<option value="">
					Use my account setting ({MARKS_LABELS[data.accountPreferences.continuousSceneMarks]})
				</option>
				<option value="shown">Shown</option>
				<option value="hidden">Hidden</option>
			</select>
		</label>
		<button type="submit">Save editor settings</button>
	</form>

	<h2>Page setup</h2>
	<p class="hint">
		How this story's print and PDF output is typeset. Anything left on "Use my account setting"
		follows your account page.
	</p>
	<form method="POST" action="?/savePageSetup">
		{#if form?.action === 'pagesetup' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'pagesetup' && form.saved}
			<p role="status">Saved.</p>
		{/if}
		<label>
			Page size
			<select name="pageSize" value={(data.pageSetupOverrides.pageSize as string) ?? ''}>
				<option value="">
					Use my account setting ({PAGE_SIZES[data.accountPageSetup.pageSize].label})
				</option>
				{#each Object.entries(PAGE_SIZES) as [value, size] (value)}
					<option {value}>{size.label}</option>
				{/each}
			</select>
		</label>
		<label>
			Margins
			<select name="margins" value={(data.pageSetupOverrides.margins as string) ?? ''}>
				<option value="">
					Use my account setting ({PAGE_MARGINS[data.accountPageSetup.margins].label})
				</option>
				{#each Object.entries(PAGE_MARGINS) as [value, margin] (value)}
					<option {value}>{margin.label}</option>
				{/each}
			</select>
		</label>
		<label>
			Font
			<select name="font" value={(data.pageSetupOverrides.font as string) ?? ''}>
				<option value="">
					Use my account setting ({PAGE_FONTS[data.accountPageSetup.font].label})
				</option>
				{#each Object.entries(PAGE_FONTS) as [value, font] (value)}
					<option {value}>{font.label}</option>
				{/each}
			</select>
		</label>
		<label>
			Font size
			<select name="fontSize" value={String(data.pageSetupOverrides.fontSize ?? '')}>
				<option value="">Use my account setting ({data.accountPageSetup.fontSize} pt)</option>
				{#each FONT_SIZES as size (size)}
					<option value={String(size)}>{size} pt</option>
				{/each}
			</select>
		</label>
		<label>
			Paragraphs
			<select
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
		</label>
		<label>
			Scene break
			<select name="sceneBreakMode" bind:value={sceneBreakMode}>
				<option value="">
					Use my account setting ({data.accountPageSetup.sceneBreak || 'plain gap'})
				</option>
				<option value="custom">Set for this story</option>
			</select>
		</label>
		{#if sceneBreakMode === 'custom'}
			<label>
				Scene break text
				<input
					type="text"
					name="sceneBreak"
					maxlength="20"
					value={(data.pageSetupOverrides.sceneBreak as string) ?? ''}
				/>
			</label>
			<p class="hint">The text printed between scenes. Leave blank for a plain gap.</p>
		{/if}
		<label>
			Page numbers (PDF downloads only)
			<select
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
		</label>
		<label>
			Story title at the top of each page (PDF downloads only)
			<select
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
		</label>
		<button type="submit">Save page setup</button>
	</form>

	<h2>Cover</h2>
	{#if data.story.coverAssetId}
		<img class="cover" src="/assets/{data.story.coverAssetId}" alt="Story cover" />
	{:else}
		<svg class="cover" viewBox="0 0 200 300" role="img" aria-label="Default cover">
			<rect width="200" height="300" rx="6" style="fill: {coverColor}" />
			<text x="100" y="150" text-anchor="middle" fill="#fff" font-size="16" font-family="serif">
				{data.story.title.slice(0, 18)}
			</text>
		</svg>
	{/if}
	{#if data.assetsConfigured}
		<form method="POST" action="?/setCover" enctype="multipart/form-data">
			{#if form?.action === 'cover' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			{#if form?.action === 'cover' && form.saved}
				<p role="status">Cover saved.</p>
			{/if}
			<label>
				Cover image
				<input
					type="file"
					name="cover"
					accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
					required
				/>
			</label>
			<button type="submit">Upload cover</button>
		</form>
	{:else}
		<p>Image uploads need the ASSET_S3_* variables set; see .env.example.</p>
	{/if}

	{#if data.archive.enabled && data.archive.handle}
		<h2>Publish <HelpLink topic="publishing" label="publishing" /></h2>
		<form method="POST" action="?/setVisibility">
			{#if form?.action === 'publish' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			{#if form?.action === 'publish' && 'saved' in form && form.saved}
				<p role="status">Saved.</p>
			{/if}
			<label>
				Visibility
				<select name="visibility" value={data.story.visibility}>
					<option value="private">Private - not on your public pages</option>
					<option value="unlisted">Unlisted - direct link only</option>
					<option value="public">Public - listed on your shelf</option>
				</select>
			</label>
			<label class="inline">
				<input type="checkbox" name="isAdult" checked={data.story.isAdult} />
				Adult content
			</label>
			<button type="submit">Save visibility</button>
		</form>
		<form method="POST" action="?/publish">
			{#if form?.action === 'publish' && 'published' in form && form.published}
				<p role="status">
					Edition published. Readers see it at
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (public reader path) -->
					<a href="/@{data.archive.handle}/{data.story.id}">
						/@{data.archive.handle}/{data.story.id}
					</a>.
				</p>
			{/if}
			<label>
				Edition label (optional)
				<input type="text" name="versionLabel" placeholder="Edition 2" />
			</label>
			<button type="submit">Publish edition</button>
			<p class="hint">
				Publishing freezes the story as it stands now. Later edits stay private until you publish
				again.
			</p>
		</form>

		{#if data.edition}
			<h2>Edition downloads</h2>
			{#if form?.action === 'exports' && form.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			{#if form?.action === 'exports' && 'queued' in form && form.queued}
				<p role="status">
					Export run queued. The files appear below in a moment; reload to see them.
				</p>
			{/if}
			{#if form?.action === 'exports' && 'saved' in form && form.saved}
				<p role="status">Saved.</p>
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
			{:else if data.assetsConfigured}
				<p>
					The download files for this edition have not been generated yet. They are created shortly
					after publishing; if they do not appear, run the generation again.
				</p>
			{:else}
				<p>Stored downloads need the ASSET_S3_* variables set; see .env.example.</p>
			{/if}
			{#if data.assetsConfigured}
				<form method="POST" action="?/regenerateExports">
					<button type="submit">Generate again</button>
				</form>
				<form method="POST" action="?/setDownloads">
					<label class="inline">
						<input type="checkbox" name="downloadsPublic" checked={data.edition.downloadsPublic} />
						Let readers download this edition (EPUB and PDF) from its public page
					</label>
					<button type="submit">Save</button>
				</form>
			{/if}
		{/if}
	{/if}

	<h2>Review</h2>
	<p>
		Invite someone to read this story and leave comments. They follow a link; no account is needed.
		{#if data.reviewInvitations.length > 0}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (app path with a suffix) -->
			<a href={`${resolve('/stories/[id]', { id: data.story.id })}/review`}>See the feedback</a>.
		{/if}
	</p>
	<form method="POST" action="?/createReviewInvite" class="invite-form">
		{#if form?.action === 'review' && form.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<label>
			Who is this link for? (optional)
			<input type="text" name="note" placeholder="e.g. Sam, my writing group" />
		</label>
		<label>
			Expires after (days)
			<input type="number" name="expiresDays" min="1" max="365" placeholder="Never" />
		</label>
		<label class="inline">
			<input type="checkbox" name="canSuggest" checked />
			Allow suggested edits (you accept or reject each one; comments are always allowed)
		</label>
		<button type="submit">Create review link</button>
	</form>
	{#if form?.action === 'review' && 'reviewLink' in form && form.reviewLink}
		<p role="status" class="review-link">
			Share this link; it is shown only once:
			<code>{form.reviewLink}</code>
			<button type="button" onclick={() => copyReviewLink(form.reviewLink as string)}>
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

	<h2>Export</h2>
	<ul class="exports">
		<!-- eslint-disable svelte/no-navigation-without-resolve (file downloads and the print view) -->
		<li>
			<a href={`${resolve('/stories/[id]', { id: data.story.id })}/export`} download>
				Markdown (.zip)
			</a>
			- every scene as a markdown file, images bundled
		</li>
		<li>
			<a href={`${resolve('/stories/[id]', { id: data.story.id })}/epub`} download>EPUB</a>
			- for e-readers
		</li>
		<li>
			<a href={`${resolve('/stories/[id]', { id: data.story.id })}/print`}>PDF</a>
			- opens a print view; choose "Save as PDF" in the print dialog
		</li>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</ul>

	<h2>History</h2>
	{#if data.timeline.length === 0}
		<p>Recent changes to this story's scenes and outline appear here.</p>
	{:else}
		<ul class="timeline">
			{#each data.timeline as row (row.id)}
				<li>
					<span class="t-name">{row.entityName ?? 'Untitled'}</span>
					<span class="t-what">
						{row.label ?? (row.reason === 'checkpoint' ? 'checkpoint' : (row.reason ?? 'autosave'))}
					</span>
					<span class="t-when">{row.createdAt.toLocaleString()}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<form method="POST" action="?/delete">
		<button type="submit" class="danger">Delete story</button>
	</form>
</main>

<style>
	label.inline {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	.hint {
		color: #777;
		font-size: 0.85rem;
	}
	.cover {
		width: 120px;
		height: 180px;
		object-fit: cover;
		border-radius: 6px;
		display: block;
		margin-bottom: 0.5rem;
	}
	.timeline {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.timeline li {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.3rem 0;
		border-bottom: 1px dashed var(--border, #ddd);
		font-size: 0.9rem;
	}
	.t-name {
		font-weight: 600;
	}
	.t-what {
		color: var(--text-muted, #666);
	}
	.t-when {
		margin-left: auto;
		color: var(--text-faint, #999);
		font-size: 0.8rem;
	}
	main {
		max-width: 36rem;
		margin: 4rem auto 0;
		padding: 0 1rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.error {
		color: var(--danger, #b00020);
	}
	.danger {
		color: var(--danger, #b00020);
		margin-top: 1.5rem;
	}
	.invite-form input[type='number'] {
		max-width: 8rem;
	}
	.review-link code {
		word-break: break-all;
	}
	.invitations {
		list-style: none;
		padding: 0;
	}
	.invitations li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.25rem 0;
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
	}
</style>
