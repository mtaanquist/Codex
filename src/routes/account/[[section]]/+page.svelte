<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import { invalidateAll } from '$app/navigation';
	import { ACCENT_PRESETS } from '$lib/appearance';
	import { FONT_SIZES, PAGE_FONTS, PAGE_MARGINS, PAGE_SIZES } from '$lib/page-setup';
	import { ADMIN_KINDS, NOTIFICATION_KINDS, NOTIFICATION_LABELS } from '$lib/notifications';
	import { WRITING_LANGUAGES } from '$lib/writing-languages';
	import { applyAppearance } from '$lib/appearance-apply';
	import PageTopBar from '$lib/components/PageTopBar.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Section = 'profile' | 'security' | 'display';

	// Each section is its own page (/account/security, /account/display);
	// a plain /account is the profile. Forms post to the section they sit
	// on, so an action result lands where it belongs without any bookkeeping.
	let active: Section = $derived((page.params.section as Section) ?? 'profile');

	function sectionHref(section: Section): string {
		return resolve('/account/[[section]]', {
			section: section === 'profile' ? undefined : section
		});
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

	// Adding a passkey is a browser ceremony, not a form post: fetch the
	// creation options, hand them to the authenticator, post the result back.
	let passkeyName = $state('');
	let passkeyError = $state<string | null>(null);
	let passkeyAdded = $state(false);
	let passkeyBusy = $state(false);
	async function addPasskey() {
		passkeyBusy = true;
		passkeyError = null;
		passkeyAdded = false;
		try {
			const optionsResponse = await fetch('/api/passkeys/register-options', { method: 'POST' });
			if (!optionsResponse.ok) {
				throw new Error((await optionsResponse.json()).message ?? 'Could not start.');
			}
			const { startRegistration } = await import('@simplewebauthn/browser');
			const response = await startRegistration({ optionsJSON: await optionsResponse.json() });
			const verifyResponse = await fetch('/api/passkeys/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ response, name: passkeyName })
			});
			if (!verifyResponse.ok) {
				throw new Error((await verifyResponse.json()).message ?? 'Could not verify.');
			}
			passkeyName = '';
			passkeyAdded = true;
			await invalidateAll();
		} catch (err) {
			// A dismissed browser prompt arrives as NotAllowedError; say it plainly.
			passkeyError =
				err instanceof Error && err.name === 'NotAllowedError'
					? 'The passkey prompt was closed before finishing.'
					: err instanceof Error
						? err.message
						: 'Something went wrong adding the passkey.';
		} finally {
			passkeyBusy = false;
		}
	}

	function onDate(date: Date): string {
		return new Date(date).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		});
	}

	// The segmented setup code. Each box holds one digit; the joined value posts
	// as `code`. A fresh page load (after a failed confirm) starts empty.
	let otpDigits = $state(['', '', '', '', '', '']);
	let otpBoxes = $state<HTMLElement>();
	const otpCode = $derived(otpDigits.join(''));
	function otpInputs(): HTMLInputElement[] {
		return otpBoxes ? Array.from(otpBoxes.querySelectorAll('input')) : [];
	}
	function onOtpInput(i: number, event: Event) {
		const el = event.target as HTMLInputElement;
		const digit = el.value.replace(/\D/g, '').slice(-1);
		otpDigits[i] = digit;
		el.value = digit;
		if (digit && i < 5) otpInputs()[i + 1]?.focus();
	}
	function onOtpKey(i: number, event: KeyboardEvent) {
		if (event.key === 'Backspace' && !otpDigits[i] && i > 0) otpInputs()[i - 1]?.focus();
	}
	function onOtpPaste(event: ClipboardEvent) {
		const text = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
		if (!text) return;
		event.preventDefault();
		otpDigits = Array.from({ length: 6 }, (_, k) => text[k] ?? '');
		otpInputs().forEach((input, k) => (input.value = otpDigits[k]));
		otpInputs()[Math.min(text.length, 5)]?.focus();
	}

	function copyText(text: string) {
		navigator.clipboard?.writeText(text).catch(() => {});
	}
	function downloadCodes(codes: string[]) {
		const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'codex-recovery-codes.txt';
		a.click();
		URL.revokeObjectURL(url);
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		const first = parts[0]?.[0] ?? '';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase() || '?';
	}

	const handleUrl = $derived(data.profile.handle ? `${data.origin}/@${data.profile.handle}` : '');

	// Only admins approve accounts, so only they see that notification row.
	const visibleKinds = $derived(
		NOTIFICATION_KINDS.filter((kind) => data.user?.isAdmin || !ADMIN_KINDS.includes(kind))
	);
</script>

<svelte:head>
	<title>Account - Codex</title>
</svelte:head>

<div class="page-shell">
	<PageTopBar
		back={{ href: resolve('/'), label: 'Library' }}
		help={{
			topic: active === 'security' ? 'security' : 'account',
			label: active === 'security' ? 'account security' : 'your account'
		}}
	/>

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

			<!-- eslint-disable svelte/no-navigation-without-resolve (sectionHref wraps resolve) -->
			<nav class="admin-nav">
				<div class="admin-nav-label">You</div>
				<a class="nav-item" class:active={active === 'profile'} href={sectionHref('profile')}>
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
				</a>
				<a class="nav-item" class:active={active === 'security'} href={sectionHref('security')}>
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
				</a>

				<div class="admin-nav-label">Workspace</div>
				<a class="nav-item" class:active={active === 'display'} href={sectionHref('display')}>
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
				</a>

				{#if data.isAdmin}
					<div class="admin-nav-label">Instance</div>
					<a class="nav-item nav-item-out" href={resolve('/admin/[[section]]', {})}>
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
			<!-- eslint-enable svelte/no-navigation-without-resolve -->

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
								{#if data.isAdmin}
									<form method="POST" action="?/enablePublishing">
										<p class="admin-block-sub" style="margin:0 0 10px;">
											Turn on publishing for your account, then claim a handle to show a public
											page.
										</p>
										<button type="submit" class="btn btn-primary">Enable publishing</button>
									</form>
								{:else}
									<p class="admin-block-sub" style="margin:0;">
										Ask an admin to enable publishing for your account before you can claim a handle
										and show a public page.
									</p>
								{/if}
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
								Add a one-time code from an authenticator app on top of your password. Codex uses
								standard TOTP, so any app works - Aegis, Ente Auth, 1Password, Google Authenticator.
							</p>
						</div>

						<div class="admin-card">
							<div class="tfa-status">
								<span class="tfa-ic">
									{#if data.twoFactor.status === 'on'}
										<svg
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="1.7"
											stroke-linecap="round"
											stroke-linejoin="round"
											><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z" /><path
												d="m9 12 2 2 4-4"
											/></svg
										>
									{:else}
										<svg
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="1.7"
											stroke-linecap="round"
											stroke-linejoin="round"
											><rect x="5" y="11" width="14" height="10" rx="2" /><path
												d="M8 11V7a4 4 0 0 1 8 0v4"
											/></svg
										>
									{/if}
								</span>
								<div class="tfa-body">
									<div class="tfa-titlerow">
										<span class="tfa-title">Authenticator app</span>
										{#if data.twoFactor.status === 'on'}
											<span class="tfa-badge">On</span>
										{:else if data.twoFactor.status === 'pending'}
											<span class="tfa-badge">Setting up</span>
										{:else}
											<span class="tfa-badge">Off</span>
										{/if}
									</div>
									<p class="tfa-sub">
										{#if data.twoFactor.status === 'on'}
											{#if data.twoFactor.confirmedAt}Enabled {onDate(data.twoFactor.confirmedAt)} -
											{/if}you'll be asked for a code on new devices. {data.twoFactor
												.recoveryRemaining} recovery codes remain.
										{:else if data.twoFactor.status === 'pending'}
											Scan the code, then enter a code to confirm.
										{:else if !data.twoFactor.available}
											Two-factor authentication is not set up on this instance.
										{:else}
											Not enabled. Anyone with your password can sign in.
										{/if}
									</p>
								</div>
								<div class="tfa-status-action">
									{#if data.twoFactor.status === 'on'}
										<div class="tfa-on-actions">
											<form method="POST" action="?/regenerateRecovery" class="tfa-guard">
												<input
													type="password"
													name="password"
													placeholder="Current password"
													autocomplete="current-password"
													aria-label="Current password"
													required
												/>
												<button type="submit" class="btn btn-secondary btn-sm"
													>Recovery codes</button
												>
											</form>
											<form method="POST" action="?/disableTotp" class="tfa-guard">
												<input
													type="password"
													name="password"
													placeholder="Current password"
													autocomplete="current-password"
													aria-label="Current password"
													required
												/>
												<button
													type="submit"
													class="btn btn-ghost btn-sm"
													style="color:var(--danger);">Turn off</button
												>
											</form>
										</div>
									{:else if data.twoFactor.status === 'pending'}
										<form method="POST" action="?/cancelTotp">
											<button type="submit" class="btn btn-ghost">Cancel</button>
										</form>
									{:else if data.twoFactor.available}
										<form method="POST" action="?/startTotp">
											<button type="submit" class="btn btn-primary">Set up</button>
										</form>
									{/if}
								</div>
							</div>

							{#if form?.scope === 'totp' && form.message}
								<p
									class="field-hint"
									role="alert"
									style="color:var(--danger); margin-top:var(--space-2);"
								>
									{form.message}
								</p>
							{/if}

							{#if data.twoFactor.status === 'pending' && data.totpSetup}
								<div class="tfa-setup">
									<div class="tfa-step">
										<span class="tfa-step-n">1</span>
										<div class="tfa-step-main">
											<div class="tfa-step-title">Scan this with your authenticator app</div>
											<p class="tfa-step-sub">Or enter the key by hand if you cannot scan.</p>
											<div class="tfa-scan">
												<div class="qr">
													<img
														src={data.totpSetup.qr}
														alt="QR code for your authenticator app"
														style="width:100%;height:100%"
													/>
												</div>
												<div class="tfa-scan-alt">
													<div class="lbl">Setup key</div>
													<p class="hint">
														Account: <span class="mono">Codex ({data.email})</span>
													</p>
													<div class="copy-field">
														<input
															id="totp-secret"
															type="text"
															value={data.totpSetup.secret}
															readonly
														/>
														<button
															type="button"
															onclick={() => copyText(data.totpSetup?.secret ?? '')}>Copy</button
														>
													</div>
													<p class="hint" style="margin-top:9px;">
														Time-based, 6 digits, refreshes every 30s.
													</p>
												</div>
											</div>
										</div>
									</div>
									<div class="tfa-step">
										<span class="tfa-step-n">2</span>
										<div class="tfa-step-main">
											<div class="tfa-step-title">Enter the 6-digit code</div>
											<p class="tfa-step-sub">
												Type the current code shown in your app to confirm it's set up.
											</p>
											<form method="POST" action="?/confirmTotp" id="totp-confirm">
												<input type="hidden" name="code" value={otpCode} />
												<div class="otp-input" bind:this={otpBoxes} onpaste={onOtpPaste}>
													{#each otpDigits as digit, i (i)}
														{#if i === 3}<span class="otp-gap"></span>{/if}
														<input
															type="text"
															inputmode="numeric"
															maxlength="1"
															value={digit}
															aria-label={`Digit ${i + 1}`}
															oninput={(event) => onOtpInput(i, event)}
															onkeydown={(event) => onOtpKey(i, event)}
														/>
													{/each}
												</div>
											</form>
										</div>
									</div>
									<div class="settings-actions">
										<form method="POST" action="?/cancelTotp">
											<button type="submit" class="btn btn-ghost">Cancel</button>
										</form>
										<button type="submit" form="totp-confirm" class="btn btn-primary"
											>Verify and turn on</button
										>
									</div>
								</div>
							{/if}

							{#if form?.scope === 'totp' && form.recoveryCodes}
								{@const codes = form.recoveryCodes}
								<div class="tfa-setup">
									<div class="tfa-step-title">Recovery codes</div>
									<p class="tfa-step-sub">
										Save these somewhere safe. Each one signs you in once if you lose your
										authenticator. They will not be shown in full again.
									</p>
									<div class="recovery-note">
										<svg
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="1.8"
											stroke-linecap="round"
											stroke-linejoin="round"
											><path
												d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
											/><line x1="12" y1="9" x2="12" y2="13" /><line
												x1="12"
												y1="17"
												x2="12"
												y2="17"
											/></svg
										>
										<span
											>Treat these like passwords. Anyone with one can get into your account.</span
										>
									</div>
									<div class="recovery-grid">
										{#each codes as code (code)}<code>{code}</code>{/each}
									</div>
									<div class="recovery-actions">
										<button
											type="button"
											class="btn btn-secondary btn-sm"
											onclick={() => copyText(codes.join('\n'))}>Copy all</button
										>
										<button
											type="button"
											class="btn btn-ghost btn-sm"
											onclick={() => downloadCodes(codes)}>Download .txt</button
										>
										<form
											method="POST"
											action="?/regenerateRecovery"
											class="tfa-guard"
											style="margin-left:auto;"
										>
											<input
												type="password"
												name="password"
												placeholder="Current password"
												autocomplete="current-password"
												aria-label="Current password"
												required
											/>
											<button type="submit" class="btn btn-ghost btn-sm">Regenerate</button>
										</form>
									</div>
								</div>
							{/if}
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Passkeys</h2>
							<p class="admin-block-sub">
								Sign in with your device's screen lock or a security key instead of typing your
								password. You can add a passkey on each device you write from.
							</p>
						</div>
						<div class="admin-card">
							{#if !data.passkeysAvailable}
								<p class="tfa-sub">
									Passkeys need APP_SECRET set on the server. Ask whoever runs this instance.
								</p>
							{:else}
								{#if data.passkeys.length > 0}
									<div class="attn-list" style="margin-bottom:var(--space-4);">
										{#each data.passkeys as passkey (passkey.id)}
											<div class="user-row">
												<div class="user-row-identity">
													<p class="user-row-name">{passkey.name ?? 'Passkey'}</p>
													<p class="user-row-email">
														Added {onDate(passkey.createdAt)}{passkey.lastUsedAt
															? ` - last used ${seen(passkey.lastUsedAt)}`
															: ''}
													</p>
												</div>
												<div class="user-row-actions">
													<form method="POST" action="?/removePasskey" class="tfa-guard">
														<input type="hidden" name="passkeyId" value={passkey.id} />
														<input
															type="password"
															name="password"
															placeholder="Current password"
															autocomplete="current-password"
															aria-label="Current password"
															required
														/>
														<button type="submit" class="btn btn-ghost btn-sm">Remove</button>
													</form>
												</div>
											</div>
										{/each}
									</div>
								{/if}
								{#if form?.scope === 'passkeys' && form.message}
									<p class="field-hint" role="alert" style="color:var(--danger);">{form.message}</p>
								{:else if form?.scope === 'passkeys' && 'removed' in form && form.removed}
									<p class="field-hint" role="status" style="color:var(--status-final);">
										Passkey removed.
									</p>
								{/if}
								{#if passkeyError}
									<p class="field-hint" role="alert" style="color:var(--danger);">{passkeyError}</p>
								{:else if passkeyAdded}
									<p class="field-hint" role="status" style="color:var(--status-final);">
										Passkey added.
									</p>
								{/if}
								<div class="settings-actions" style="justify-content:flex-start;">
									<input
										class="input"
										type="text"
										placeholder="Name this passkey, e.g. laptop"
										aria-label="Passkey name"
										bind:value={passkeyName}
										style="max-width:240px;"
									/>
									<button
										type="button"
										class="btn btn-primary"
										disabled={passkeyBusy}
										onclick={addPasskey}
									>
										{passkeyBusy ? 'Waiting for your device...' : 'Add passkey'}
									</button>
								</div>
							{/if}
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
									<button type="submit" class="btn btn-danger">Sign out all other sessions</button>
								</form>
							</div>
						{/if}
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Your data</h2>
							<p class="admin-block-sub">
								Download everything you have written - every universe, story, scene, and
								worldbuilding entry, with relationships, story notes, review feedback, and your
								images - as a folder of markdown files.
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
												<strong style="color:var(--text);font-weight:600;">Markdown.</strong> Formatting
												marks like ** and # stay visible as you type, styled in place.
											</li>
											<li>
												<strong style="color:var(--text);font-weight:600;">Rich text.</strong> The marks
												hide except on the line you are editing, so the page reads like formatted text.
											</li>
										</ul>
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
										Whether the continuous story view shows a divider and label between scenes, or
										reads as one uninterrupted manuscript.
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
										The Session tab's streak card: the week's writing days and the run you are on.
										Hide it if the scorekeeping is not for you.
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
										A daily word target. The Session tab and Insights show progress toward it. Leave
										it blank or zero for no goal.
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

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Notifications</h2>
							<p class="admin-block-sub">
								What reaches you, and where: the bell in the top bar, email, both, or neither.
								Emails arrive batched, so a busy hour sends one message.
							</p>
						</div>
						<div class="settings-group">
							<form method="POST" action="?/saveNotifications">
								<table class="notify-grid">
									<thead>
										<tr>
											<th></th>
											<th scope="col">In app</th>
											<th scope="col">Email</th>
										</tr>
									</thead>
									<tbody>
										{#each visibleKinds as kind (kind)}
											<tr>
												<th scope="row">{NOTIFICATION_LABELS[kind]}</th>
												<td>
													<input
														type="checkbox"
														name="inapp_{kind}"
														checked={data.preferences.notifications[kind].inApp}
														aria-label="{NOTIFICATION_LABELS[kind]} in app"
													/>
												</td>
												<td>
													<input
														type="checkbox"
														name="email_{kind}"
														checked={data.preferences.notifications[kind].email}
														aria-label="{NOTIFICATION_LABELS[kind]} by email"
													/>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
								<div class="settings-actions">
									{#if form?.scope === 'notifyprefs' && form.saved}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Saved.</span
										>
									{/if}
									<button type="submit" class="btn btn-primary">Save notifications</button>
								</div>
							</form>
						</div>
					</div>

					<div class="admin-block">
						<div class="admin-block-head">
							<h2 class="admin-block-title">Page setup</h2>
							<p class="admin-block-sub">
								How print and PDF output is typeset. These are your defaults; a story can override
								them in its own settings.
							</p>
						</div>
						<div class="settings-group">
							<form method="POST" action="?/savePageSetup">
								<div class="field">
									<label for="ps-size">Page size</label>
									<select
										id="ps-size"
										class="select"
										name="pageSize"
										value={data.pageSetup.pageSize}
									>
										{#each Object.entries(PAGE_SIZES) as [value, size] (value)}
											<option {value}>{size.label}</option>
										{/each}
									</select>
								</div>
								<div class="field">
									<label for="ps-margins">Margins</label>
									<select
										id="ps-margins"
										class="select"
										name="margins"
										value={data.pageSetup.margins}
									>
										{#each Object.entries(PAGE_MARGINS) as [value, margin] (value)}
											<option {value}>{margin.label}</option>
										{/each}
									</select>
								</div>
								<div class="field">
									<label for="ps-font">Font</label>
									<select id="ps-font" class="select" name="font" value={data.pageSetup.font}>
										{#each Object.entries(PAGE_FONTS) as [value, font] (value)}
											<option {value}>{font.label}</option>
										{/each}
									</select>
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
									<label for="ps-scenebreak">Scene break</label>
									<input
										id="ps-scenebreak"
										class="input"
										type="text"
										name="sceneBreak"
										maxlength="20"
										value={data.pageSetup.sceneBreak}
									/>
									<p class="field-hint">
										The text printed between scenes. Leave blank for a plain gap.
									</p>
								</div>
								<div class="field">
									<label class="check-row">
										<input
											type="checkbox"
											name="pageNumbers"
											checked={data.pageSetup.pageNumbers}
										/>
										Page numbers (PDF downloads only)
									</label>
									<label class="check-row">
										<input
											type="checkbox"
											name="runningHeader"
											checked={data.pageSetup.runningHeader}
										/>
										Story title at the top of each page (PDF downloads only)
									</label>
								</div>
								<div class="settings-actions">
									{#if form?.scope === 'pagesetup' && form.message}
										<span class="field-hint" role="alert" style="color:var(--danger);"
											>{form.message}</span
										>
									{:else if form?.scope === 'pagesetup' && form.saved}
										<span class="field-hint" role="status" style="color:var(--status-final);"
											>Saved.</span
										>
									{/if}
									<button type="submit" class="btn btn-primary">Save page setup</button>
								</div>
							</form>
						</div>
					</div>
				</section>
			</div>
		</main>
	</div>
</div>
