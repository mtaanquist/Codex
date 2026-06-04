<script lang="ts">
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import { ACCENT_PRESETS } from '$lib/appearance';
	import { applyAppearance } from '$lib/appearance-apply';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Section = 'profile' | 'security' | 'display';
	function sectionFor(scope: string | undefined): Section | null {
		switch (scope) {
			case 'name':
			case 'profile':
			case 'handle':
				return 'profile';
			case 'password':
			case 'email':
			case 'sessions':
			case 'delete':
				return 'security';
			case 'prefs':
			case 'appearance':
				return 'display';
			default:
				return null;
		}
	}

	let active = $state<Section>('profile');
	$effect(() => {
		const s = sectionFor(form?.scope);
		if (s) active = s;
	});

	function go(section: Section) {
		active = section;
	}

	let avatarForm = $state<HTMLFormElement | null>(null);

	// The links editor works on a local copy seeded once from the loaded
	// profile; the form posts it as JSON. Start with one empty row so there is
	// always something to fill in.
	// svelte-ignore state_referenced_locally
	let links = $state(
		data.profile.links?.length
			? data.profile.links.map((link) => ({ ...link }))
			: [{ label: '', url: '' }]
	);
	function addLink() {
		links = [...links, { label: '', url: '' }];
	}
	function removeLink(index: number) {
		links = links.filter((_, i) => i !== index);
		if (links.length === 0) links = [{ label: '', url: '' }];
	}
	const linksJson = $derived(JSON.stringify(links.filter((link) => link.url.trim())));

	// Appearance preview: local state seeded from the saved preferences, applied
	// live as the user edits. Saving persists it; the layout re-applies on load.
	// svelte-ignore state_referenced_locally
	let theme = $state(data.preferences.theme);
	// svelte-ignore state_referenced_locally
	let accent = $state(data.preferences.accent);
	$effect(() => {
		if (browser) applyAppearance(theme, accent);
	});

	function seen(date: Date): string {
		return new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		const first = parts[0]?.[0] ?? '';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase() || '?';
	}

	const handleUrl = $derived(data.profile.handle ? `${data.origin}/@${data.profile.handle}` : '');
</script>

<svelte:head>
	<title>Account - Codex</title>
</svelte:head>

<div class="page-shell">
	<header class="topbar">
		<a class="brand" href={resolve('/')}>
			<span class="brand-name">Codex</span>
		</a>
		<span class="divider"></span>
		<a class="back-link" href={resolve('/')}>
			<svg
				viewBox="0 0 12 12"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"><polyline points="7.5 2.5 3 6 7.5 9.5" /></svg
			>
			Library
		</a>
		<span class="spacer"></span>
	</header>

	<div class="admin-shell">
		<aside class="admin-sidebar">
			<div class="admin-sidebar-title">
				<span
					class="ic"
					style="background:linear-gradient(140deg,var(--accent),color-mix(in oklab,var(--accent) 55%,#000));color:#fff;font-weight:700;font-size:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.2);"
					>{initials(data.displayName)}</span
				>
				<div>
					<div class="tt">{data.displayName}</div>
					<div class="st">{data.email}</div>
				</div>
			</div>

			<nav class="admin-nav">
				<div class="admin-nav-label">You</div>
				<button class="nav-item" class:active={active === 'profile'} onclick={() => go('profile')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg
					>
					<span class="lbl">Profile</span>
				</button>
				<button
					class="nav-item"
					class:active={active === 'security'}
					onclick={() => go('security')}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><rect x="3" y="11" width="18" height="11" rx="2" /><path
							d="M7 11V7a5 5 0 0 1 10 0v4"
						/></svg
					>
					<span class="lbl">Security</span>
				</button>

				<div class="admin-nav-label">Workspace</div>
				<button class="nav-item" class:active={active === 'display'} onclick={() => go('display')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><rect x="2" y="3" width="20" height="14" rx="2" /><line
							x1="8"
							y1="21"
							x2="16"
							y2="21"
						/><line x1="12" y1="17" x2="12" y2="21" /></svg
					>
					<span class="lbl">Display</span>
				</button>

				{#if data.isAdmin}
					<div class="admin-nav-label">Instance</div>
					<a class="nav-item nav-item-out" href={resolve('/admin')}>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z" /></svg
						>
						<span class="lbl">Admin panel</span>
						<svg
							class="nav-out-arrow"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.9"
							stroke-linecap="round"
							stroke-linejoin="round"
							><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path
								d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"
							/></svg
						>
					</a>
				{/if}
			</nav>

			<div
				class="admin-health"
				style="background:transparent;box-shadow:none;border:0;padding:12px 4px 2px;"
			>
				<form method="POST" action="?/signout">
					<button class="btn btn-secondary" type="submit" style="width:100%;justify-content:center;"
						>Sign out</button
					>
				</form>
			</div>
		</aside>

		<main class="admin-main page-body">
			<div class="admin-main-inner">
				<!-- ========== PROFILE ========== -->
				<section class="admin-section" class:active={active === 'profile'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Account</p>
						<h1 class="admin-title">Profile</h1>
						<p class="admin-lede">
							Your identity in the app, and the public page other people can see.
						</p>
					</div>

					<div class="admin-block">
						<div class="settings-group">
							<div class="avatar-edit">
								<div class="avatar-lg">
									{#if data.profile.avatarAssetId}
										<img src="/assets/{data.profile.avatarAssetId}" alt="" />
									{:else}
										{initials(data.displayName)}
									{/if}
								</div>
								<div class="avatar-edit-actions">
									{#if data.assetsConfigured}
										<div class="row">
											<form
												method="POST"
												action="?/uploadAvatar"
												enctype="multipart/form-data"
												bind:this={avatarForm}
											>
												<label class="btn btn-secondary btn-sm">
													Upload photo
													<input
														type="file"
														name="file"
														accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
														hidden
														onchange={() => avatarForm?.requestSubmit()}
													/>
												</label>
											</form>
											{#if data.profile.avatarAssetId}
												<form method="POST" action="?/removeAvatar">
													<button type="submit" class="btn btn-ghost btn-sm">Remove</button>
												</form>
											{/if}
										</div>
										<p class="avatar-edit-hint">
											PNG, JPEG, WebP, GIF or AVIF, up to 10 MB. A square image works best.
										</p>
										{#if form?.scope === 'avatar' && form.message}
											<span class="field-hint" role="alert" style="color:var(--danger);"
												>{form.message}</span
											>
										{/if}
									{:else}
										<p class="avatar-edit-hint">Image uploads are not set up on this instance.</p>
									{/if}
								</div>
							</div>

							<form method="POST" action="?/updateName">
								<div class="field">
									<label for="display-name">Display name</label>
									<input
										id="display-name"
										class="input"
										type="text"
										name="displayName"
										value={data.displayName}
										required
										autocomplete="name"
									/>
									<p class="field-hint">
										Shown in your avatar initials and on any notes you write.
									</p>
								</div>
								<div class="field">
									<label for="pen-name">Pen name <span class="lbl-opt">optional</span></label>
									<input
										id="pen-name"
										class="input"
										type="text"
										name="penName"
										value={data.profile.penName ?? ''}
										placeholder="A name to publish under, if different from your own"
									/>
									<p class="field-hint">
										Used as the author name on stories and your public page when set.
									</p>
								</div>
								<div class="settings-actions">
									{#if form?.scope === 'name' && form.message}
										<span class="field-hint" role="alert" style="color:var(--danger);"
											>{form.message}</span
										>
									{:else if form?.scope === 'name' && form.saved}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Saved.</span
										>
									{/if}
									<button type="submit" class="btn btn-primary">Save changes</button>
								</div>
							</form>
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Public page</h2>
							<p class="admin-block-sub">
								A simple page at your handle - a short bio readers can find. Private by default.
							</p>
						</div>

						{#if !data.profile.publicArchiveEnabled}
							<div class="admin-card">
								<p class="admin-block-sub" style="margin:0;">
									Ask an admin to enable publishing for your account before you can claim a handle
									and show a public page.
								</p>
							</div>
						{:else if !data.profile.handle}
							<div class="admin-card">
								<form method="POST" action="?/claimHandle">
									<div class="field" style="margin-bottom:0;">
										<label for="handle">Claim your handle</label>
										<input
											id="handle"
											class="input"
											type="text"
											name="handle"
											placeholder="your-name"
											pattern="[a-z0-9][a-z0-9-]+"
											required
										/>
										<p class="field-hint">
											3-30 characters: letters, numbers, and dashes. This is permanent and cannot be
											changed once claimed.
										</p>
									</div>
									<div class="settings-actions">
										{#if form?.scope === 'handle' && form.message}
											<span class="field-hint" role="alert" style="color:var(--danger);"
												>{form.message}</span
											>
										{/if}
										<button type="submit" class="btn btn-primary">Claim handle</button>
									</div>
								</form>
							</div>
						{:else}
							<div class="admin-card">
								<form method="POST" action="?/saveProfile">
									<div class="toggle-row vis-head" style="margin-bottom:var(--space-4);">
										<div>
											<div class="t-title">Visibility</div>
											<div class="t-sub">
												When on, your handle page is listed publicly with the bio below.
											</div>
										</div>
										<label class="toggle">
											<input
												type="checkbox"
												name="profilePublic"
												checked={data.profile.profilePublic}
											/>
											<span class="toggle-track"></span>
										</label>
									</div>

									<div class="field">
										<label for="page-address">Page address</label>
										<div class="copy-field">
											<input id="page-address" type="text" value={handleUrl} readonly />
										</div>
										<p class="field-hint">
											Where your page lives. Publish stories from their settings page.
										</p>
									</div>

									<div class="field">
										<label for="bio">Bio</label>
										<textarea
											id="bio"
											class="textarea"
											name="bioMd"
											rows="3"
											placeholder="A short paragraph about you. Basic Markdown is fine."
											>{data.profile.bioMd ?? ''}</textarea
										>
									</div>

									<div class="field">
										<!-- svelte-ignore a11y_label_has_associated_control -->
										<label>Links</label>
										<input type="hidden" name="links" value={linksJson} />
										<div class="link-list">
											{#each links as link, i (i)}
												<div class="link-row">
													<input
														type="text"
														class="input"
														style="max-width:9rem;"
														placeholder="Label"
														aria-label="Link label"
														bind:value={link.label}
													/>
													<input
														type="text"
														class="input"
														placeholder="https://example.com"
														aria-label="Link address"
														bind:value={link.url}
													/>
													<button
														type="button"
														class="link-del"
														aria-label="Remove link"
														onclick={() => removeLink(i)}
													>
														<svg
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12" /></svg
														>
													</button>
												</div>
											{/each}
										</div>
										<button type="button" class="btn btn-ghost btn-sm link-add" onclick={addLink}>
											<svg
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
												><line x1="12" y1="5" x2="12" y2="19" /><line
													x1="5"
													y1="12"
													x2="19"
													y2="12"
												/></svg
											>Add link
										</button>
										<p class="field-hint">
											Your website, social profiles, or anywhere else readers can find you.
										</p>
									</div>

									<div class="field" style="margin-bottom:0;">
										<!-- svelte-ignore a11y_label_has_associated_control -->
										<label>Commissions</label>
										<div class="toggle-row" style="margin-bottom:var(--space-2);">
											<label class="toggle">
												<input
													type="checkbox"
													name="commissionsOpen"
													checked={data.profile.commissionsOpen}
												/>
												<span class="toggle-track"></span>
											</label>
											<div style="flex:1;">
												<div class="t-title">Open for commissions</div>
												<div class="t-sub">Shows an "open" note on your page.</div>
											</div>
										</div>
										<input
											type="text"
											class="input"
											name="commissionsMd"
											value={data.profile.commissionsMd ?? ''}
											placeholder="A line about what you take on"
										/>
									</div>

									<div class="settings-actions">
										{#if form?.scope === 'profile' && form.message}
											<span class="field-hint" role="alert" style="color:var(--danger);"
												>{form.message}</span
											>
										{:else if form?.scope === 'profile' && form.saved}
											<span class="field-hint" role="status" style="color:var(--status-final);"
												>Saved.</span
											>
										{/if}
										<button type="submit" class="btn btn-primary">Save public page</button>
									</div>
								</form>
							</div>
						{/if}
					</div>
				</section>

				<!-- ========== SECURITY ========== -->
				<section class="admin-section" class:active={active === 'security'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Account</p>
						<h1 class="admin-title">Security</h1>
						<p class="admin-lede">Your email, password, and the devices currently signed in.</p>
					</div>

					<div class="admin-block">
						<div class="settings-group">
							<header class="settings-group-header">
								<h2 class="settings-group-title">Email</h2>
								<p class="settings-group-subtitle">
									Your address is <strong>{data.email}</strong>. Changing it sends a confirmation
									link to the new address; your current address stays until you confirm.
								</p>
							</header>
							<form method="POST" action="?/changeEmail">
								<div class="field">
									<label for="new-email">New email</label>
									<input
										id="new-email"
										class="input"
										type="email"
										name="newEmail"
										required
										autocomplete="email"
									/>
								</div>
								<div class="field">
									<label for="email-password">Confirm your password</label>
									<input
										id="email-password"
										class="input"
										type="password"
										name="password"
										required
										autocomplete="current-password"
									/>
								</div>
								<div class="settings-actions">
									{#if form?.scope === 'email' && form.message}
										<span class="field-hint" role="alert" style="color:var(--danger);"
											>{form.message}</span
										>
									{:else if form?.scope === 'email' && form.sent}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Check your new inbox for a confirmation link.</span
										>
									{/if}
									<button type="submit" class="btn btn-primary">Change email</button>
								</div>
							</form>
						</div>
					</div>

					<div class="admin-block">
						<div class="settings-group">
							<header class="settings-group-header">
								<h2 class="settings-group-title">Password</h2>
								<p class="settings-group-subtitle">Change the password you use to sign in.</p>
							</header>
							<form method="POST" action="?/changePassword">
								<div class="field">
									<label for="current-password">Current password</label>
									<input
										id="current-password"
										class="input"
										type="password"
										name="currentPassword"
										required
										autocomplete="current-password"
									/>
								</div>
								<div class="field">
									<label for="new-password">New password</label>
									<input
										id="new-password"
										class="input"
										type="password"
										name="newPassword"
										required
										minlength="8"
										autocomplete="new-password"
									/>
								</div>
								<div class="settings-actions">
									{#if form?.scope === 'password' && form.message}
										<span class="field-hint" role="alert" style="color:var(--danger);"
											>{form.message}</span
										>
									{:else if form?.scope === 'password' && form.saved}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Password changed. Other devices were signed out.</span
										>
									{/if}
									<button type="submit" class="btn btn-primary">Update password</button>
								</div>
							</form>
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Two-factor authentication</h2>
							<p class="admin-block-sub">
								A one-time code from an authenticator app on top of your password.
							</p>
						</div>
						<div class="admin-card">
							<p class="admin-block-sub" style="margin:0;">Coming in a later release.</p>
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Sessions</h2>
							<p class="admin-block-sub">Devices currently signed in to your account.</p>
						</div>
						<div class="admin-card tight">
							<div class="attn-list">
								{#each data.sessions as session (session.id)}
									<div class="user-row">
										<div
											class="user-row-avatar"
											style="background:var(--bg-inset);color:var(--text-muted);"
										>
											<svg
												width="18"
												height="18"
												viewBox="0 0 20 20"
												fill="none"
												stroke="currentColor"
												stroke-width="1.5"
												stroke-linecap="round"
												stroke-linejoin="round"
												><rect x="3" y="4" width="14" height="10" rx="1" /><line
													x1="6"
													y1="17"
													x2="14"
													y2="17"
												/><line x1="10" y1="14" x2="10" y2="17" /></svg
											>
										</div>
										<div class="user-row-identity">
											<p class="user-row-name">{session.userAgent ?? 'Unknown device'}</p>
											<p class="user-row-email">Last active {seen(session.lastSeenAt)}</p>
										</div>
										<div class="user-row-actions">
											{#if session.current}
												<span class="pill pill-accent">Current</span>
											{:else}
												<form method="POST" action="?/revokeSession">
													<input type="hidden" name="sessionId" value={session.id} />
													<button type="submit" class="btn btn-ghost btn-sm">Revoke</button>
												</form>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
						{#if data.sessions.length > 1}
							<div class="settings-actions">
								{#if form?.scope === 'sessions' && form.saved}
									<span class="field-hint" role="status" style="color:var(--status-final);"
										>Done.</span
									>
								{/if}
								<form method="POST" action="?/revokeOthers">
									<button type="submit" class="btn btn-secondary">Sign out everywhere else</button>
								</form>
							</div>
						{/if}
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Your data</h2>
							<p class="admin-block-sub">
								Download everything you have written - every universe, story, scene, and
								worldbuilding entry, with your images - as a folder of markdown files.
							</p>
						</div>
						<div class="admin-card">
							<a class="btn btn-secondary" href={resolve('/account/export')} data-sveltekit-reload
								>Download everything</a
							>
						</div>
					</div>

					<div class="admin-block">
						<div class="settings-group danger-group">
							<header class="settings-group-header">
								<h2 class="settings-group-title">Delete account</h2>
								<p class="settings-group-subtitle">
									This deletes your account and everything you have written. Your public pages come
									down straight away, and after {data.graceDays} days everything is removed for good.
									We email you a link to cancel if you change your mind. Download your work above first
									if you want a copy.
								</p>
							</header>
							<form method="POST" action="?/deleteAccount">
								<div class="field">
									<label for="delete-password">Confirm your password to continue</label>
									<input
										id="delete-password"
										class="input"
										type="password"
										name="password"
										required
										autocomplete="current-password"
									/>
								</div>
								<div class="settings-actions">
									{#if form?.scope === 'delete' && form.message}
										<span class="field-hint" role="alert" style="color:var(--danger);"
											>{form.message}</span
										>
									{/if}
									<button type="submit" class="btn btn-danger">Delete my account</button>
								</div>
							</form>
						</div>
					</div>
				</section>

				<!-- ========== DISPLAY ========== -->
				<section class="admin-section" class:active={active === 'display'}>
					<div class="admin-head">
						<p class="admin-eyebrow">Account</p>
						<h1 class="admin-title">Display</h1>
						<p class="admin-lede">How the app looks, and how the editor behaves while you write.</p>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Appearance</h2>
							<p class="admin-block-sub">The colour theme and accent used across the app.</p>
						</div>
						<div class="settings-group">
							<form method="POST" action="?/saveAppearance">
								<div class="field">
									<label for="theme-pref">Theme</label>
									<select id="theme-pref" class="select" name="theme" bind:value={theme}>
										<option value="system">Follow system</option>
										<option value="light">Light</option>
										<option value="dark">Dark</option>
									</select>
								</div>

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
												onclick={() => (accent = preset.value)}
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
									{#if form?.scope === 'appearance' && form.message}
										<span class="field-hint" role="alert" style="color:var(--danger);"
											>{form.message}</span
										>
									{:else if form?.scope === 'appearance' && form.saved}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Saved.</span
										>
									{/if}
									<button type="submit" class="btn btn-primary">Save display</button>
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
							<form method="POST" action="?/savePreferences">
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
										How the editor suggests completions when you start typing a name it already
										knows.
										<ul>
											<li>
												<strong style="color:var(--text);font-weight:600;"
													>Inline ghost-text.</strong
												>
												The completion appears as faded text after your cursor; press <kbd>Tab</kbd> to
												accept.
											</li>
											<li>
												<strong style="color:var(--text);font-weight:600;">Popup menu.</strong> A
												small dropdown with all matches; arrow keys to choose, <kbd>Enter</kbd> to accept.
											</li>
										</ul>
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
										Whether the continuous story view shows a divider and label between scenes, or
										reads as one uninterrupted manuscript.
									</div>
								</div>
								<div class="settings-actions">
									{#if form?.scope === 'prefs' && form.message}
										<span class="field-hint" role="alert" style="color:var(--danger);"
											>{form.message}</span
										>
									{:else if form?.scope === 'prefs' && form.saved}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Saved.</span
										>
									{/if}
									<button type="submit" class="btn btn-primary">Save preferences</button>
								</div>
							</form>
						</div>
					</div>
				</section>
			</div>
		</main>
	</div>
</div>
