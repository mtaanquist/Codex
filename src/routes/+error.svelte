<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { libraryCrumb, pageCrumb } from '#lib/chrome';
	import AppBar from '#lib/components/AppBar.svelte';
	import AuthShell from '#lib/components/AuthShell.svelte';

	// Access checks answer 404 for anything the visitor cannot see, so a page
	// only ever needs two cases: not found, and everything else.
	const notFound = $derived(page.status === 404);
	const title = $derived(notFound ? 'Page not found' : 'Something went wrong');
	const text = $derived.by(() => {
		if (!notFound) return 'Try again in a moment.';
		return page.data.user
			? 'This page does not exist. If a story or universe was renamed, open it from your library.'
			: 'This page does not exist.';
	});
</script>

<svelte:head>
	<title>{title} - Codex</title>
</svelte:head>

{#if page.data.user}
	<div class="page-shell">
		<AppBar crumbs={[libraryCrumb(), pageCrumb(title)]} />
		<main id="main" class="page-body">
			<div class="page-container">
				<div class="page-header">
					<h1 class="page-title">{title}</h1>
				</div>
				<div class="empty-state">
					<p class="empty-state-text">{text}</p>
					<a class="btn btn-primary empty-state-action" href={resolve('/')}>Go to your library</a>
				</div>
			</div>
		</main>
	</div>
{:else}
	<AuthShell {title}>
		<p class="auth-sub">{text}</p>
		<div class="auth-actions">
			<a class="btn btn-primary" href={resolve('/login')}>Sign in</a>
		</div>
	</AuthShell>
{/if}
