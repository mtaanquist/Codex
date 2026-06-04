<script lang="ts">
	import { resolve } from '$app/paths';
	import { entityColor } from '$lib/entity-color';
	import { renderMarkdown } from '$lib/markdown';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The reader page de-indexes adult work; the shelf shows its title,
	// cover, and description, so it must de-index too when any book is adult.
	const hasAdult = $derived(data.shelf.some((book) => book.isAdult));

	const profile = $derived(data.profile);
	const authorName = $derived(profile ? (profile.penName ?? profile.displayName) : '');

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		const first = parts[0]?.[0] ?? '';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase() || '?';
	}

	// Only http(s) addresses become live links; anything else (a bare handle,
	// say) is shown as plain text so a profile cannot inject other schemes.
	function linkHref(url: string): string | null {
		return /^https?:\/\//i.test(url) ? url : null;
	}
</script>

<svelte:head>
	<title>@{data.handle} - Codex</title>
	{#if hasAdult}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<main class="shelf">
	{#if profile}
		<header class="profile">
			<div class="avatar">
				{#if profile.avatarAssetId}
					<img src="/assets/{profile.avatarAssetId}" alt="" />
				{:else}
					<span>{initials(authorName)}</span>
				{/if}
			</div>
			<div class="profile-text">
				<h1>{authorName}</h1>
				<p class="profile-handle">@{data.handle}</p>
				{#if profile.bioMd}
					<!-- Author markdown; renderMarkdown escapes raw HTML. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="profile-bio">{@html renderMarkdown(profile.bioMd)}</div>
				{/if}
				{#if profile.links.length > 0}
					<ul class="profile-links">
						{#each profile.links as link (link.url)}
							<li>
								{#if linkHref(link.url)}
									<!-- An external author link, not an app route; resolve() does not apply. -->
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
									<a href={linkHref(link.url)} rel="nofollow noopener">{link.label || link.url}</a>
								{:else}
									<span>{link.label ? `${link.label}: ${link.url}` : link.url}</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				{#if profile.commissionsOpen}
					<p class="commissions">
						<span class="commissions-badge">Open for commissions</span>
						{#if profile.commissionsMd}<span class="commissions-line">{profile.commissionsMd}</span
							>{/if}
					</p>
				{/if}
			</div>
		</header>
	{:else}
		<h1>@{data.handle}</h1>
	{/if}
	{#if data.shelf.length === 0}
		<p>Nothing published here yet.</p>
	{:else}
		<ul class="books">
			{#each data.shelf as book (book.storyId)}
				<li>
					<a
						href={resolve('/@[handle]/[story=uuid]', { handle: data.handle, story: book.storyId })}
					>
						{#if book.coverAssetId}
							<img class="cover" src="/assets/{book.coverAssetId}" alt="" />
						{:else}
							<svg class="cover" viewBox="0 0 200 300" aria-hidden="true">
								<rect width="200" height="300" rx="6" style="fill: {entityColor(book.title)}" />
								<text x="100" y="150" text-anchor="middle" fill="#fff" font-size="16">
									{book.title.slice(0, 18)}
								</text>
							</svg>
						{/if}
						<span class="book-title">{book.title}</span>
					</a>
					{#if book.author}<p class="book-author">{book.author}</p>{/if}
					{#if book.isAdult}<p class="adult-badge">Adult content</p>{/if}
					{#if book.descriptionMd}
						<!-- Author markdown; renderMarkdown escapes raw HTML. -->
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<div class="book-brief">{@html renderMarkdown(book.descriptionMd)}</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	.shelf {
		max-width: 44rem;
		margin: 0 auto;
		padding: 3rem 1rem;
		font-family: Georgia, serif;
		color: #1a1a1a;
		background: #fff;
	}
	h1 {
		font-size: 1.6rem;
		margin-bottom: 2rem;
	}
	.profile {
		display: flex;
		gap: 1.25rem;
		align-items: flex-start;
		margin-bottom: 2.5rem;
	}
	.profile .avatar {
		flex: none;
		width: 5rem;
		height: 5rem;
		border-radius: 50%;
		overflow: hidden;
		background: #1a4a8a;
		color: #fff;
		display: grid;
		place-items: center;
		font-size: 1.6rem;
		font-weight: 700;
	}
	.profile .avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.profile-text {
		min-width: 0;
	}
	.profile h1 {
		margin: 0;
	}
	.profile-handle {
		margin: 0.15rem 0 0;
		color: #666;
		font-size: 0.95rem;
	}
	.profile-bio {
		margin-top: 0.75rem;
	}
	.profile-bio :global(p) {
		margin: 0.4rem 0;
	}
	.profile-links {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		font-size: 0.9rem;
	}
	.profile-links a {
		color: #1a4a8a;
	}
	.commissions {
		margin: 0.85rem 0 0;
		font-size: 0.9rem;
	}
	.commissions-badge {
		display: inline-block;
		background: #e7f3ea;
		color: #1e5631;
		border-radius: 999px;
		padding: 0.1rem 0.6rem;
		font-weight: 700;
		font-size: 0.8rem;
		margin-right: 0.5rem;
	}
	.commissions-line {
		color: #444;
	}
	.books {
		list-style: none;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		gap: 2rem;
	}
	.books a {
		color: inherit;
		text-decoration: none;
	}
	.books a:focus-visible {
		outline: 3px solid #1a4a8a;
		outline-offset: 3px;
	}
	.cover {
		width: 100%;
		aspect-ratio: 2 / 3;
		object-fit: cover;
		border-radius: 6px;
		display: block;
	}
	.book-title {
		display: block;
		margin-top: 0.6rem;
		font-weight: 700;
	}
	.book-author,
	.book-brief {
		margin: 0.2rem 0 0;
		font-size: 0.9rem;
		color: #444;
	}
	.adult-badge {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: #8a1a1a;
		font-weight: 700;
	}
</style>
