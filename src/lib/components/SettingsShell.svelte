<script lang="ts">
	import type { Snippet } from 'svelte';

	// The shared admin-shell scaffold behind the settings-style pages (account,
	// admin, story settings, universe, universe insights): the app bar, a left
	// sidebar, and the scrolling main column. Each page supplies its own bar
	// and sidebar (title + nav) and drops its content in as the default child;
	// the wrapper structure and its classes live here once.
	let {
		topbar,
		sidebar,
		children
	}: {
		// The AppBar for this page, rendered above the shell.
		topbar: Snippet;
		// The sidebar body: the title block and the nav.
		sidebar: Snippet;
		// The main column content.
		children: Snippet;
	} = $props();
</script>

<div class="page-shell">
	{@render topbar()}

	<div class="admin-shell">
		<aside class="admin-sidebar">
			{@render sidebar()}
		</aside>
		<main class="admin-main page-body">
			<div class="admin-main-inner">
				{@render children()}
			</div>
		</main>
	</div>
</div>
