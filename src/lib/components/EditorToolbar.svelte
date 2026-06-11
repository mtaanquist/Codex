<script lang="ts">
	import { onMount } from 'svelte';
	import type { EditorView } from '@codemirror/view';
	import Icon, { type IconName } from './Icon.svelte';
	import {
		decreaseIndent,
		increaseIndent,
		setAlignment,
		setHeading,
		toggleBold,
		toggleBulletList,
		toggleItalic,
		toggleQuote
	} from '$lib/editor-format';
	import { ALIGNMENTS } from '$lib/alignment';
	import { dismiss } from '$lib/dismiss';
	import ViewMenu, { type ViewItem } from './ViewMenu.svelte';

	// The formatting bar above a prose editor: headings, bold, italic, quote,
	// list, alignment, indent, and the view toggles. Buttons act on the editor
	// and hand focus straight back. Tools that do not fit the width collapse into
	// a "more" menu, so the bar never overflows.
	let {
		view,
		onSplitScene,
		viewMenu,
		storyView,
		nonPrintingActive,
		onToggleNonPrinting,
		commandMarkersActive,
		onToggleCommandMarkers,
		onCoauthor,
		coauthorActive
	}: {
		view: () => EditorView | undefined;
		// When set, a split button breaks the scene at the cursor.
		onSplitScene?: () => void;
		// The View dropdown (Edit, Preview, Focus, Print); shown at the end of the
		// bar when set, the same on the Write and Review toolbars.
		viewMenu?: ViewItem[];
		// The scene <-> whole-story toggle, shown at the end of the bar.
		storyView?: { active: boolean; toggleHref: string };
		// The view toggles: show non-printing characters, and hide the command
		// markers (\center and friends). Each button appears only when its
		// toggle callback is set; active marks the toggle as on.
		nonPrintingActive?: boolean;
		onToggleNonPrinting?: () => void;
		commandMarkersActive?: boolean;
		onToggleCommandMarkers?: () => void;
		// When set, a "Write with the Assistant" button opens the co-author panel;
		// active marks the panel as open.
		onCoauthor?: () => void;
		coauthorActive?: boolean;
	} = $props();

	function run(command: (view: EditorView) => boolean) {
		const editor = view();
		if (!editor) return;
		command(editor);
		editor.focus();
	}

	type Item =
		| { kind: 'sep' }
		| { kind: 'cmd'; id: string; title: string; label?: string; icon?: IconName; act: () => void }
		| {
				kind: 'toggle';
				id: string;
				title: string;
				menuLabel: string;
				icon: IconName;
				active: boolean;
				toggle: () => void;
		  };

	// The ordered main-tool list. The same descriptors render inline (icon
	// button) or, once overflowed, as a row in the "more" menu.
	const items = $derived.by(() => {
		const out: Item[] = [
			{ kind: 'cmd', id: 'h1', title: 'Heading 1', label: 'H1', act: () => run(setHeading(1)) },
			{ kind: 'cmd', id: 'h2', title: 'Heading 2', label: 'H2', act: () => run(setHeading(2)) },
			{ kind: 'cmd', id: 'h3', title: 'Heading 3', label: 'H3', act: () => run(setHeading(3)) },
			{ kind: 'sep' },
			{ kind: 'cmd', id: 'bold', title: 'Bold (Ctrl+B)', icon: 'bold', act: () => run(toggleBold) },
			{
				kind: 'cmd',
				id: 'italic',
				title: 'Italic (Ctrl+I)',
				icon: 'italic',
				act: () => run(toggleItalic)
			},
			{ kind: 'sep' },
			{ kind: 'cmd', id: 'quote', title: 'Quote', icon: 'quote', act: () => run(toggleQuote) },
			{
				kind: 'cmd',
				id: 'list',
				title: 'Bullet list',
				icon: 'list',
				act: () => run(toggleBulletList)
			},
			{ kind: 'sep' },
			...ALIGNMENTS.map(
				(align): Item => ({
					kind: 'cmd',
					id: `align-${align}`,
					title: `Align ${align}`,
					icon: `align-${align}` as IconName,
					act: () => run(setAlignment(align))
				})
			),
			{ kind: 'sep' },
			{
				kind: 'cmd',
				id: 'indent-dec',
				title: 'Decrease indent (Ctrl+[)',
				icon: 'indent-decrease',
				act: () => run(decreaseIndent)
			},
			{
				kind: 'cmd',
				id: 'indent-inc',
				title: 'Increase indent (Ctrl+])',
				icon: 'indent-increase',
				act: () => run(increaseIndent)
			}
		];
		const toggles: Item[] = [];
		if (onToggleNonPrinting) {
			toggles.push({
				kind: 'toggle',
				id: 'nonprint',
				title: 'Show non-printing characters',
				menuLabel: 'Show non-printing characters',
				icon: 'pilcrow',
				active: !!nonPrintingActive,
				toggle: onToggleNonPrinting
			});
		}
		if (onToggleCommandMarkers) {
			toggles.push({
				kind: 'toggle',
				id: 'cmdmark',
				title: 'Show command markers (\\center, \\indent)',
				menuLabel: 'Show command markers (\\center, \\indent)',
				icon: 'eye',
				active: !!commandMarkersActive,
				toggle: onToggleCommandMarkers
			});
		}
		if (toggles.length) out.push({ kind: 'sep' }, ...toggles);
		if (onSplitScene) {
			out.push(
				{ kind: 'sep' },
				{
					kind: 'cmd',
					id: 'split',
					title: 'Split scene at cursor',
					icon: 'split',
					act: () => onSplitScene()
				}
			);
		}
		return out;
	});

	// How many leading items fit on the bar; the rest move into the menu. Starts
	// at "all" so the server render and the first paint show the full bar.
	let visibleCount = $state(Number.MAX_SAFE_INTEGER);
	let barEl = $state<HTMLElement>();
	let rightEl = $state<HTMLElement>();
	let measureEl = $state<HTMLElement>();

	// The visible run, with any separator that would dangle before the "more"
	// button trimmed off; and the overflow, with separators dropped.
	const visible = $derived.by(() => {
		const list = items.slice(0, visibleCount);
		while (list.length && list[list.length - 1].kind === 'sep') list.pop();
		return list;
	});
	const overflow = $derived(items.slice(visibleCount).filter((it) => it.kind !== 'sep'));

	function recompute() {
		if (!barEl || !measureEl) return;
		const kids = Array.from(measureEl.children) as HTMLElement[];
		if (kids.length < 1) return;
		const moreEl = kids[kids.length - 1];
		const toolEls = kids.slice(0, kids.length - 1);
		const styles = getComputedStyle(barEl);
		const padL = parseFloat(styles.paddingLeft) || 0;
		const padR = parseFloat(styles.paddingRight) || 0;
		const rightW = rightEl ? rightEl.offsetWidth : 0;
		const gap = 3;
		const avail = barEl.clientWidth - padL - padR - (rightW > 0 ? rightW + gap : 0);
		const base = measureEl.getBoundingClientRect().left;
		// Cumulative right edge through each tool, gaps and separator margins
		// included (so the maths matches the real flex layout).
		const cum = toolEls.map((el) => el.getBoundingClientRect().right - base);
		const totalAll = cum.length ? cum[cum.length - 1] : 0;
		if (totalAll <= avail) {
			visibleCount = items.length;
			return;
		}
		const moreW = moreEl.getBoundingClientRect().width + gap;
		const budget = avail - moreW;
		let count = 0;
		for (let i = 0; i < cum.length; i++) {
			if (cum[i] <= budget) count = i + 1;
			else break;
		}
		visibleCount = count;
	}

	onMount(() => {
		recompute();
		const ro = new ResizeObserver(() => recompute());
		if (barEl) ro.observe(barEl);
		return () => ro.disconnect();
	});

	// Re-measure when the tool set itself changes (a toggle appears, the mode
	// switches). Reading `items` ties the effect to those changes.
	$effect(() => {
		void items;
		recompute();
	});

	// The "more" menu. Closes on an outside press or Escape.
	let menuOpen = $state(false);
	// A vanished overflow (the bar grew) must not leave a stale open menu.
	$effect(() => {
		if (overflow.length === 0) menuOpen = false;
	});
</script>

<div class="md-toolbar" bind:this={barEl}>
	<!-- Off-screen full-width copy used only to measure each tool's natural size.
	     The zero-size clip keeps the wide row from ever adding a scrollbar. -->
	<div class="md-measure-clip" aria-hidden="true">
		<div class="md-measure" bind:this={measureEl}>
			{#each items as item (item.kind === 'sep' ? `sep-${items.indexOf(item)}` : item.id)}
				{#if item.kind === 'sep'}
					<span class="md-sep"></span>
				{:else if item.kind === 'cmd'}
					<span class="md-tool"
						>{#if item.icon}<Icon name={item.icon} size={16} />{:else}<span class="md-tool-label"
								>{item.label}</span
							>{/if}</span
					>
				{:else}
					<span class="md-tool"><Icon name={item.icon} size={16} /></span>
				{/if}
			{/each}
			<span class="md-tool"><Icon name="more" size={16} /></span>
		</div>
	</div>

	{#each visible as item, i (item.kind === 'sep' ? `sep-${i}` : item.id)}
		{#if item.kind === 'sep'}
			<span class="md-sep"></span>
		{:else if item.kind === 'cmd'}
			<button
				class="md-tool"
				type="button"
				title={item.title}
				onmousedown={(event) => event.preventDefault()}
				onclick={item.act}
			>
				{#if item.icon}
					<Icon name={item.icon} size={16} />
				{:else}
					<span class="md-tool-label">{item.label}</span>
				{/if}
			</button>
		{:else}
			<button
				class="md-tool"
				class:is-active={item.active}
				type="button"
				title={item.title}
				aria-pressed={item.active}
				onmousedown={(event) => event.preventDefault()}
				onclick={item.toggle}
			>
				<Icon name={item.icon} size={16} />
			</button>
		{/if}
	{/each}

	{#if overflow.length > 0}
		<span class="md-sep"></span>
		<div class="md-overflow" use:dismiss={{ enabled: menuOpen, close: () => (menuOpen = false) }}>
			<button
				class="md-tool"
				class:is-active={menuOpen}
				type="button"
				aria-label="More tools"
				title="More tools"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onmousedown={(event) => event.preventDefault()}
				onclick={() => (menuOpen = !menuOpen)}
			>
				<Icon name="more" size={16} />
			</button>
			{#if menuOpen}
				<div class="md-menu" role="menu">
					{#each overflow as item (item.id)}
						{#if item.kind === 'cmd'}
							<button
								class="md-menu-item"
								type="button"
								role="menuitem"
								onmousedown={(event) => event.preventDefault()}
								onclick={() => {
									item.act();
									menuOpen = false;
								}}
							>
								<span class="md-menu-ic">
									{#if item.icon}<Icon name={item.icon} size={15} />{:else}{item.label}{/if}
								</span>
								{item.title}
							</button>
						{:else}
							<button
								class="md-menu-item"
								type="button"
								role="menuitemcheckbox"
								aria-checked={item.active}
								onmousedown={(event) => event.preventDefault()}
								onclick={() => item.toggle()}
							>
								<span class="md-menu-check">{item.active ? '✓' : ''}</span>
								{item.menuLabel}
							</button>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<div class="md-right" bind:this={rightEl}>
		{#if onCoauthor}
			<button
				class="md-tool md-coauthor"
				class:is-active={coauthorActive}
				type="button"
				title="Write a passage with the Assistant"
				onclick={() => onCoauthor()}
			>
				<Icon name="sparkles" size={15} />
				<span class="md-tool-label">Write</span>
			</button>
		{/if}
		{#if storyView}
			<!-- eslint-disable svelte/no-navigation-without-resolve (resolved path plus a query string) -->
			<a
				class="md-tool"
				href={storyView.toggleHref}
				title={storyView.active ? 'Back to the scene editor' : 'Read the whole story'}
			>
				<Icon name={storyView.active ? 'scene' : 'chapter'} size={16} />
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
		{#if viewMenu}
			<ViewMenu items={viewMenu} />
		{/if}
	</div>
</div>

<style>
	/* Measures every tool's natural width off-screen so the overflow split can be
	   computed without the visible bar ever wrapping. The clip is a zero-size box
	   so the wide row never adds a scrollbar; the row inside still lays out (and
	   so measures) at its full natural width. */
	.md-measure-clip {
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		overflow: hidden;
		visibility: hidden;
		pointer-events: none;
	}
	.md-measure {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 0;
		margin: 0;
		width: max-content;
		white-space: nowrap;
	}
	.md-overflow {
		position: relative;
		display: inline-flex;
	}
	.md-menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 20;
		min-width: 232px;
		padding: 6px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
	}
	.md-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		padding: 7px 8px;
		border: 0;
		border-radius: 7px;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.md-menu-item:hover {
		background: var(--bg-hover);
	}
	.md-menu-check,
	.md-menu-ic {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.2em;
		flex: none;
		color: var(--accent);
		font-weight: 700;
	}
	.md-menu-ic {
		color: var(--text-muted);
	}
	.md-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.md-coauthor {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
	}
	.md-coauthor:hover,
	.md-coauthor.is-active {
		color: var(--accent);
	}
</style>
