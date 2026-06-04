<script lang="ts">
	import { resolve } from '$app/paths';
	import { entityColor } from '$lib/entity-color';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>@{data.handle} - Codex</title>
</svelte:head>

<main class="shelf">
	<h1>@{data.handle}</h1>
	{#if data.shelf.length === 0}
		<p>Nothing published here yet.</p>
	{:else}
		<ul class="books">
			{#each data.shelf as book (book.storyId)}
				<li>
					<a href={resolve('/@[handle]/[story]', { handle: data.handle, story: book.storyId })}>
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
					{#if book.descriptionMd}<p class="book-brief">{book.descriptionMd}</p>{/if}
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
