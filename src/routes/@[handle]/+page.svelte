<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '$lib/markdown';
	import AppBar from '$lib/components/AppBar.svelte';
	import ReaderFooter from '$lib/components/ReaderFooter.svelte';
	import { pageCrumb } from '$lib/chrome';
	import { authorInitials, authorName } from '$lib/author-name';
	import { formatNumber } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The reader page de-indexes adult work; the shelf shows its title,
	// cover, and description, so it must de-index too when any book is adult.
	const hasAdult = $derived(data.shelf.some((book) => book.isAdult));

	const profile = $derived(data.profile);
	// The chrome names the author; the handle is the address, so it stays in the
	// URL and in the header line under the name.
	const author = $derived(authorName(profile));
	const shelfHref = $derived(resolve('/@[handle]', { handle: data.handle }));

	// Only http(s) addresses become live links; anything else (a bare handle,
	// say) is shown as plain text so a profile cannot inject other schemes.
	function linkHref(url: string): string | null {
		return /^https?:\/\//i.test(url) ? url : null;
	}

	function published(date: Date): string {
		return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
	}
</script>

<svelte:head>
	<title>{author ? `${author} (@${data.handle})` : `@${data.handle}`} - Codex</title>
	{#if hasAdult}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<div class="reader-shell">
	<AppBar
		shell="reader"
		crumbs={[pageCrumb(author || `@${data.handle}`)]}
		pathLabel="What you are reading"
		helpTopic="publishing"
		helpLabel="reading pages"
	/>

	<main class="reader-main">
		<div class="reader-col wide">
			<div class="shelf-head">
				<span class="shelf-avatar" aria-hidden="true">
					{#if profile?.avatarAssetId}
						<img src="/assets/{profile.avatarAssetId}" alt="" />
					{:else}
						{authorInitials(author || data.handle)}
					{/if}
				</span>
				<div>
					<h1 class="shelf-name">{author || `@${data.handle}`}</h1>
					<p class="shelf-handle">
						@{data.handle} - {formatNumber(data.shelf.length)}
						{data.shelf.length === 1 ? 'story' : 'stories'} published
					</p>
				</div>
			</div>

			{#if profile?.bioMd}
				<!-- Author markdown; renderMarkdown escapes raw HTML. -->
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="shelf-bio">{@html renderMarkdown(profile.bioMd)}</div>
			{/if}

			{#if profile && (profile.links.length > 0 || profile.commissionsOpen)}
				<ul class="shelf-meta">
					{#if profile.commissionsOpen}
						<li>
							<span class="pill pill-accent">Open for commissions</span>
							{#if profile.commissionsMd}{profile.commissionsMd}{/if}
						</li>
					{/if}
					<!-- Keyed by index: this is a short static list, and a URL is not a
					     safe key (older rows may hold duplicates that would crash hydration). -->
					{#each profile.links as link, i (i)}
						<li>
							{#if linkHref(link.url)}
								<!-- An external author link, not an app route; resolve() does not apply. -->
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
								<a href={linkHref(link.url)} rel="nofollow noopener">{link.label || link.url}</a>
							{:else}
								{link.label ? `${link.label}: ${link.url}` : link.url}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<h2 class="shelf-label">Published</h2>
			{#if data.shelf.length === 0}
				<p class="reader-byline">Nothing published here yet.</p>
			{:else}
				<ul class="shelf-grid">
					{#each data.shelf as book (book.storyId)}
						<li>
							<a
								class="shelf-item"
								href={resolve('/@[handle]/[story=uuid]', {
									handle: data.handle,
									story: book.storyId
								})}
							>
								<!-- A cover is the story's own title, set, until an author
								     uploads artwork. -->
								<span class="shelf-cover">
									{#if book.coverAssetId}
										<img src="/assets/{book.coverAssetId}" alt="" />
									{:else}
										{book.title}
									{/if}
								</span>
								<span class="shelf-item-title">{book.title}</span>
								<span class="shelf-item-meta">
									{published(book.publishedAt)}{#if book.isAdult}
										- adult content{/if}
								</span>
								{#if book.descriptionMd}
									<!-- Author markdown; renderMarkdown escapes raw HTML. -->
									<!-- eslint-disable-next-line svelte/no-at-html-tags -->
									<span class="shelf-item-brief">{@html renderMarkdown(book.descriptionMd)}</span>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</main>

	<ReaderFooter {author} {shelfHref} belongs="shelf" />
</div>
