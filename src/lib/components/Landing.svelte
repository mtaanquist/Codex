<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import AppBar from './AppBar.svelte';
	import ReaderFooter from './ReaderFooter.svelte';
	import { signupOffered, type SignupMode } from '$lib/signup-mode';

	// The signed-out page shows the workspace instead of describing it, and one
	// switch over that one figure stands in for three audiences.
	//
	// Who can make an account decides what the page offers, so it takes the mode
	// rather than a boolean: 'invite' accepts new accounts but not requests, so
	// offering a codeless visitor the sign-up page would send them nowhere.
	let { mode = 'approval' }: { mode?: SignupMode } = $props();

	const offerSignup = $derived(signupOffered(mode));
	const signupLabel = $derived(mode === 'open' ? 'Create an account' : 'Request access');

	type PostureId = 'novel' | 'world' | 'table';
	const postures: { id: PostureId; label: string }[] = [
		{ id: 'novel', label: 'Novelist' },
		{ id: 'world', label: 'Worldbuilder' },
		{ id: 'table', label: 'Game master' }
	];

	let active = $state<PostureId>('novel');
	let tabs: Record<string, HTMLButtonElement | undefined> = $state({});

	// The same keyboard contract as the right pane's panel strip: one tab stop,
	// arrows between tabs, Home and End to the ends.
	function move(from: PostureId, key: string) {
		const index = postures.findIndex((p) => p.id === from);
		if (index < 0) return null;
		if (key === 'ArrowRight' || key === 'ArrowDown') return postures[(index + 1) % postures.length];
		if (key === 'ArrowLeft' || key === 'ArrowUp')
			return postures[(index - 1 + postures.length) % postures.length];
		if (key === 'Home') return postures[0];
		if (key === 'End') return postures[postures.length - 1];
		return null;
	}

	function onKeydown(event: KeyboardEvent, id: PostureId) {
		const next = move(id, event.key);
		if (!next) return;
		event.preventDefault();
		active = next.id;
		tabs[next.id]?.focus();
	}

	const docs = resolve('/docs');
	const shortcuts = resolve('/docs/[topic]', { topic: 'shortcuts' });
	const publishing = resolve('/docs/[topic]', { topic: 'publishing' });
	const selfhosting = resolve('/docs/[topic]', { topic: 'selfhosting' });
</script>

<div class="public-surface">
	<AppBar shell="public" />

	<main class="public-main">
		<div class="public-in">
			<section class="hero">
				<h1 class="hero-title">Write the story. Keep <em>the world it comes from.</em></h1>
				<p class="hero-lede">
					One workspace, three columns: what you are working through on the left, the page in the
					middle, and everything that page mentions on the right. A novel, a serial, a world, a
					campaign - the same three columns, holding whatever you keep.
				</p>
				<div class="hero-cta">
					<a class="btn btn-primary" href={resolve('/login')}>Sign in</a>
					{#if offerSignup}
						<a class="btn btn-secondary" href={resolve('/signup')}>{signupLabel}</a>
					{/if}
				</div>
			</section>

			<section class="figure" aria-labelledby="figure-label">
				<div class="figure-head">
					<span class="figure-label" id="figure-label">The workspace</span>
					<div class="seg posture-strip" role="tablist" aria-label="Who is at the desk">
						{#each postures as posture (posture.id)}
							<button
								bind:this={tabs[posture.id]}
								class="seg-btn"
								class:active={active === posture.id}
								type="button"
								role="tab"
								id="tab-{posture.id}"
								aria-controls="fig-{posture.id}"
								aria-selected={active === posture.id}
								tabindex={active === posture.id ? 0 : -1}
								onclick={() => (active = posture.id)}
								onkeydown={(event) => onKeydown(event, posture.id)}
							>
								{posture.label}
							</button>
						{/each}
					</div>
				</div>

				{@render figurePanel(
					'novel',
					'Novelist',
					'A novel.',
					'Chapters and scenes on the left, the draft in the middle, and the people and places this scene mentions on the right. Four modes - Write, Plan, Notes, Review - and the same four wherever you are.',
					novelFigure
				)}
				{@render figurePanel(
					'world',
					'Worldbuilder',
					'A world.',
					'The same window, no story open: entries by category on the left, the entry in the middle, and on the right every scene and entry that mentions it. Nothing was added to Codex to make this view; you switched modes.',
					worldFigure
				)}
				{@render figurePanel(
					'table',
					'Game master',
					'A campaign.',
					"Sessions where chapters were, tonight's scene in the middle, and your notes on the right, attached to the scene rather than to a file somewhere else. Prep, run, and write up in one place.",
					tableFigure
				)}
			</section>

			<section class="model" aria-labelledby="model-head">
				<h2 class="model-head" id="model-head">Four things worth stating before you sign in.</h2>
				<div class="model-grid">
					<div class="model-item">
						<div class="model-term">Run it yourself, or let us run it</div>
						<p class="model-body">
							Install Codex on your own computer, or use the hosted version. It is the same Codex
							either way, with the same features, and you can move your work from one to the other
							whenever you like.
						</p>
					</div>
					<div class="model-item">
						{#if mode === 'open'}
							<div class="model-term">Anyone can make an account</div>
							<p class="model-body">
								Sign up with an email address and start writing. There is no queue and nothing to
								wait for.
							</p>
						{:else if mode === 'none'}
							<div class="model-term">New accounts are closed, for now</div>
							<p class="model-body">
								This Codex is not taking new accounts at the moment. If you need one, ask the person
								who runs it.
							</p>
						{:else if mode === 'invite'}
							<div class="model-term">Accounts open by invitation, for now</div>
							<p class="model-body">
								Accounts open by invitation while the work is young. Requests are closed at the
								moment, but anyone already writing here can invite you, so ask them for a code.
							</p>
						{:else}
							<div class="model-term">Accounts open by invitation, for now</div>
							<p class="model-body">
								Accounts open by invitation while the work is young. Ask for one and you get an
								answer - yes, or when - rather than a place in a queue nobody describes.
							</p>
						{/if}
					</div>
					<div class="model-item">
						<div class="model-term">Your words leave as markdown</div>
						<p class="model-body">
							Every scene, entry and note exports as a plain markdown file, in the folders you see
							in the app. Open the export in any editor and it still reads as your book.
						</p>
					</div>
					<div class="model-item">
						<div class="model-term">No AI unless you ask</div>
						<p class="model-body">
							The assistant is a panel you open, and it never writes into your draft until you
							accept an edit. Turn it off in settings and nothing else changes: Codex is a complete
							writing tool with the assistant off.
						</p>
					</div>
				</div>
				<div class="close-row">
					<p class="close-note">
						The <a href={docs}>handbook</a> is open before you sign in: the
						<a href={shortcuts}>keyboard shortcuts</a>, how
						<a href={publishing}>reading pages</a>
						work, and how to <a href={selfhosting}>run Codex yourself</a>.
					</p>
					<span class="cta">
						<a class="btn btn-primary" href={resolve('/login')}>Sign in</a>
						{#if offerSignup}
							<a class="btn btn-secondary" href={resolve('/signup')}>{signupLabel}</a>
						{/if}
					</span>
				</div>
			</section>
		</div>
	</main>

	<ReaderFooter shell="public" />
</div>

<!-- ===================================================================== -->
<!-- The figure. A stylised rendering of the three-pane shell, drawn from the
     same tokens as the product rather than a screenshot, so it is correct in
     dark, light and warm. The tools are three plain squares on purpose: a
     public figure should not invite you to click a control that is not there.
     The content is fictional sample data. -->

{#snippet figurePanel(
	id: PostureId,
	label: string,
	capLead: string,
	capText: string,
	body: Snippet
)}
	<div
		class="ws-panel"
		id="fig-{id}"
		role="tabpanel"
		aria-labelledby="tab-{id}"
		hidden={active !== id}
	>
		<!-- The figure keeps all three columns at every width and scrolls
		     sideways instead of dropping one, so it stays focusable for a
		     keyboard. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scroll container is
		     reachable on purpose; it carries a group role and a name) -->
		<div
			class="ws-scroll"
			tabindex="0"
			role="group"
			aria-label="The Codex workspace, {label.toLowerCase()}"
		>
			<div class="ws">{@render body()}</div>
		</div>
		<p class="figure-cap"><b>{capLead}</b> {capText}</p>
	</div>
{/snippet}

{#snippet wsBar(trail: string[])}
	<div class="ws-bar">
		<span class="ws-logo"><Icon name="feather" size={11} /></span>
		<span class="ws-brand">Codex</span>
		<span class="ws-rule"></span>
		<span class="ws-path">
			{#each trail as place, index (index)}
				{#if index > 0}<span class="sep">/</span>{/if}
				<span class={index === trail.length - 1 ? 'now' : undefined}>{place}</span>
			{/each}
		</span>
		<span class="ws-tools">
			<span class="ws-tool"></span><span class="ws-tool"></span><span class="ws-tool"></span>
		</span>
	</div>
{/snippet}

{#snippet wsSeg(items: string[], on: string)}
	<div class="ws-seg">
		{#each items as item (item)}
			<span class={item === on ? 'on' : undefined}>{item}</span>
		{/each}
	</div>
{/snippet}

{#snippet novelFigure()}
	{@render wsBar(['Library', 'The Shattered Realms', 'Book of Ash'])}
	<div class="ws-body">
		<div class="ws-col">
			{@render wsSeg(['Write', 'Plan', 'Notes', 'Review'], 'Write')}
			<div class="ws-filter">Filter chapters and scenes</div>
			<div class="ws-label">Chapters<span class="n">6</span></div>
			<div class="ws-row head"><span class="t">Chapter 1</span><span class="n">3</span></div>
			<div class="ws-row sub on">
				<span class="t">Departure from Halden</span><span class="n">1.4k</span>
			</div>
			<div class="ws-row sub">
				<span class="t">The toll road at dusk</span><span class="n">1.1k</span>
			</div>
			<div class="ws-row sub">
				<span class="t">Ash on the water</span><span class="n">0.9k</span>
			</div>
			<div class="ws-row head"><span class="t">Chapter 2</span><span class="n">4</span></div>
			<div class="ws-row head"><span class="t">Chapter 3</span><span class="n">2</span></div>
		</div>
		<div class="ws-col centre">
			<div class="ws-kicker">Chapter 1 - scene 1</div>
			<h3 class="ws-title">Departure from Halden</h3>
			<div class="ws-prose">
				<p>
					The gate of <span class="ws-ref">Halden</span> opened the way it always did, with a groan
					that carried across the toll road and out over
					<span class="ws-ref">the frozen marsh</span>.
				</p>
				<p>
					<span class="ws-ref">Alice</span> counted the carts ahead of her and decided the line would
					take until dusk. She had three seasons of ash in her ledger and one promise left to keep.
				</p>
				<p>
					The gatekeeper knew her face, which was either an advantage or the end of everything,
					depending on which rumour had reached him first.
				</p>
			</div>
			<div class="ws-fade"></div>
		</div>
		<div class="ws-col">
			{@render wsSeg(['Reference', 'Assistant', 'History', 'Notes'], 'Reference')}
			<div class="ws-card">
				<div class="ws-card-title">In this scene</div>
				<div class="ws-label">Characters</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-rose)">A</span>
					<span class="t">Alice Vance</span><span class="n">18</span>
				</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-teal)">G</span>
					<span class="t">The gatekeeper</span><span class="n">3</span>
				</div>
				<div class="ws-label">Places</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-green)">H</span>
					<span class="t">Halden</span><span class="n">6</span>
				</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-cyan)">M</span>
					<span class="t">The frozen marsh</span><span class="n">2</span>
				</div>
			</div>
			<p class="ws-hint">
				Everything the scene mentions that also has an entry. Open one to read or edit it.
			</p>
		</div>
	</div>
{/snippet}

{#snippet worldFigure()}
	{@render wsBar(['Library', 'The Shattered Realms'])}
	<div class="ws-body">
		<div class="ws-col">
			{@render wsSeg(['Write', 'Plan', 'Notes', 'Review'], 'Plan')}
			<div class="ws-filter">Filter entries</div>
			<div class="ws-label">Entries<span class="n">214</span></div>
			<div class="ws-row head">
				<span class="ws-dot" style="background: var(--cat-violet)"></span>
				<span class="t">Factions</span><span class="n">21</span>
			</div>
			<div class="ws-row sub on"><span class="t">House Veren</span><span class="n">14</span></div>
			<div class="ws-row sub"><span class="t">The Ashfall</span><span class="n">9</span></div>
			<div class="ws-row head">
				<span class="ws-dot" style="background: var(--cat-green)"></span>
				<span class="t">Places</span><span class="n">63</span>
			</div>
			<div class="ws-row sub"><span class="t">Halden</span><span class="n">6</span></div>
			<div class="ws-row head">
				<span class="ws-dot" style="background: var(--cat-amber)"></span>
				<span class="t">Lore</span><span class="n">48</span>
			</div>
			<div class="ws-row sub"><span class="t">The Toll Charter</span><span class="n">4</span></div>
		</div>
		<div class="ws-col centre">
			<div class="ws-kicker">Factions - entry</div>
			<h3 class="ws-title">House Veren</h3>
			<div class="ws-prose">
				<p>
					Veren holds <span class="ws-ref">the Toll Charter</span>, and through it the only legal
					road across <span class="ws-ref">the frozen marsh</span>. Everything the house has, it has
					because of that one document.
				</p>
				<p>
					They keep a second ledger in <span class="ws-ref">Halden</span>, which is where the
					trouble starts: the tolls it records were never collected.
				</p>
			</div>
			<div class="ws-fade"></div>
		</div>
		<div class="ws-col">
			{@render wsSeg(['Reference', 'Assistant', 'History', 'Notes'], 'Reference')}
			<div class="ws-card">
				<div class="ws-card-title">Where this appears</div>
				<div class="ws-label">Scenes</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-blue)">D</span>
					<span class="t">Departure from Halden</span><span class="n">3</span>
				</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-blue)">T</span>
					<span class="t">The toll road at dusk</span><span class="n">2</span>
				</div>
				<div class="ws-label">Entries</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-amber)">T</span>
					<span class="t">The Toll Charter</span><span class="n">5</span>
				</div>
				<div class="ws-row">
					<span class="ws-chip" style="background: var(--cat-green)">H</span>
					<span class="t">Halden</span><span class="n">2</span>
				</div>
			</div>
			<p class="ws-hint">
				The same panel, read the other way: every scene and entry that mentions this one.
			</p>
		</div>
	</div>
{/snippet}

{#snippet tableFigure()}
	{@render wsBar(['Library', 'Aldermoor', 'Session 12'])}
	<div class="ws-body">
		<div class="ws-col">
			{@render wsSeg(['Write', 'Plan', 'Notes', 'Review'], 'Write')}
			<div class="ws-filter">Filter sessions and scenes</div>
			<div class="ws-label">Sessions<span class="n">12</span></div>
			<div class="ws-row head"><span class="t">Session 11</span><span class="n">4</span></div>
			<div class="ws-row head"><span class="t">Session 12</span><span class="n">3</span></div>
			<div class="ws-row sub on">
				<span class="t">The Ashfall Vigil</span><span class="n">1.2k</span>
			</div>
			<div class="ws-row sub">
				<span class="t">If they open the crypt</span><span class="n">0.6k</span>
			</div>
			<div class="ws-row sub">
				<span class="t">Read-aloud: the bells</span><span class="n">0.2k</span>
			</div>
			<div class="ws-row head">
				<span class="t">Session 13 - planned</span><span class="n">1</span>
			</div>
		</div>
		<div class="ws-col centre">
			<div class="ws-kicker">Session 12 - scene 1</div>
			<h3 class="ws-title">The Ashfall Vigil</h3>
			<div class="ws-prose">
				<p>
					The party arrives while <span class="ws-ref">Brother Talon</span> is still ringing. He
					will not stop for them, and he will not answer to <span class="ws-ref">the Warden's</span> name.
				</p>
				<p>
					If they say they came from <span class="ws-ref">Halden</span>, he opens the gate. If they
					say anything about the charter, he closes it and sends a runner.
				</p>
			</div>
			<div class="ws-fade"></div>
		</div>
		<div class="ws-col">
			{@render wsSeg(['Reference', 'Assistant', 'History', 'Notes'], 'Notes')}
			<div class="ws-card">
				<div class="ws-card-title">Notes on this scene</div>
				<p class="ws-note">
					The table knows the bells mean a death, not a summons. They do not know whose.
				</p>
				<p class="ws-note">Talon's name came from a player. Keep it; it is better than mine.</p>
			</div>
			<p class="ws-hint">
				Notes stay with the scene, so what the table already knows is beside what happens next.
			</p>
		</div>
	</div>
{/snippet}
