<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Codex</title>
</svelte:head>

<main>
	<h1>Codex</h1>
	<p>Signed in as {data.user.displayName}.</p>
	<form method="POST" action="?/signout">
		<button type="submit">Sign out</button>
	</form>
</main>

<style>
	main {
		max-width: 30rem;
		margin: 15vh auto 0;
		font-family: system-ui, sans-serif;
	}
</style>
