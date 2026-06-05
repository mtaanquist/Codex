<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
</script>

<div class="landing-surface">
	<nav class="landing-nav">
		<a class="brand" href={resolve('/')}>
			<span class="logo"><Icon name="feather" size={15} /></span>
			<span class="brand-name">Codex</span>
		</a>
		<span class="spacer"></span>
		<ThemeToggle />
		<a class="btn btn-ghost btn-sm" href={resolve('/login')}>Sign in</a>
	</nav>

	<section class="landing-hero">
		<div class="landing-hero-inner">
			<p class="landing-kicker">A writing tool</p>
			<h1 class="landing-title">Plan the world.<br /><em>Write the book.</em></h1>
			<p class="landing-tagline">
				A self-hosted workspace for long-form fiction. Plan your world in one view, draft your prose
				in the next. Your words stay on your machine.
			</p>

			<div class="landing-cta">
				<a class="btn btn-primary" href={resolve('/login')}>Sign in</a>
				<a class="btn btn-secondary" href={resolve('/signup')}>Request access</a>
			</div>

			<div class="landing-features">
				<div class="landing-feature">
					<span class="landing-feature-marker">Plan</span>
					<p class="landing-feature-body">
						Characters, places, lore, and an outline - all side by side with the prose, all
						cross-referenced.
					</p>
				</div>
				<div class="landing-feature">
					<span class="landing-feature-marker">Write</span>
					<p class="landing-feature-body">
						A markdown editor that quietly knows every name you have introduced. Distraction-free
						when you want it.
					</p>
				</div>
				<div class="landing-feature">
					<span class="landing-feature-marker">Remember</span>
					<p class="landing-feature-body">
						Every save snapshotted. Every mention tracked. Find any use of any entity across every
						scene.
					</p>
				</div>
				<div class="landing-feature">
					<span class="landing-feature-marker">Yours</span>
					<p class="landing-feature-body">
						Markdown under the hood, EPUB on the way out. Self-hosted and portable. Your work
						exports whole, any time.
					</p>
				</div>
			</div>
		</div>
	</section>

	<footer class="landing-foot">Self-hosted · Invite-only</footer>
</div>

<style>
	.spacer {
		flex: 1;
	}
</style>
