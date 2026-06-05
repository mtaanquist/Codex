<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { deserialize } from '$app/forms';
	import { closePalette, openPalette, palette } from '$lib/palette.svelte';
	import type { SearchResult } from '$lib/server/search';

	// The command palette: Ctrl+K (or the topbar button) opens it; type to
	// search everything you own and to filter the commands that fit where
	// you are; arrows move, Enter runs, Escape closes.

	type Item = {
		label: string;
		sublabel: string | null;
		kind: string;
		run: () => void | Promise<void>;
	};

	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let selected = $state(0);
	let inputEl = $state<HTMLInputElement>();
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	const TYPE_LABELS: Record<string, string> = {
		universe: 'Universe',
		story: 'Story',
		scene: 'Scene',
		character: 'Character',
		place: 'Place',
		lore: 'Lore'
	};

	function navigate(href: string): () => Promise<void> {
		return async () => {
			closePalette();
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- app paths built from owned refs (slug or id) and fixed routes
			await goto(href);
		};
	}

	// Posts one of the story page's form actions (new chapter, new scene)
	// and follows the redirect or refreshes, depending on what it returns.
	function storyAction(storyRef: string, action: string): () => Promise<void> {
		return async () => {
			closePalette();
			const response = await fetch(`/stories/${storyRef}?/${action}`, {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body: new FormData()
			});
			const result = deserialize(await response.text());
			if (result.type === 'redirect') {
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- the action's own redirect target
				await goto(result.location, { invalidateAll: true });
			} else {
				await invalidateAll();
			}
		};
	}

	// Navigation and action commands that make sense where the user is.
	const commands = $derived.by((): Item[] => {
		const path = page.url.pathname;
		const list: Item[] = [];
		const storyMatch = path.match(/^\/stories\/([^/]+)/);
		const universeMatch = path.match(/^\/universes\/([^/]+)/);
		if (storyMatch) {
			const storyRef = storyMatch[1];
			list.push(
				{
					label: 'New scene',
					sublabel: null,
					kind: 'Command',
					run: storyAction(storyRef, 'createScene')
				},
				{
					label: 'New chapter',
					sublabel: null,
					kind: 'Command',
					run: storyAction(storyRef, 'createChapter')
				},
				{ label: 'Write', sublabel: null, kind: 'Go to', run: navigate(`/stories/${storyRef}`) },
				{
					label: 'Story view',
					sublabel: 'The whole story as one document',
					kind: 'Go to',
					run: navigate(`/stories/${storyRef}?view=story`)
				},
				{
					label: 'Plan this story',
					sublabel: null,
					kind: 'Go to',
					run: navigate(`/stories/${storyRef}/plan`)
				},
				{
					label: 'Story settings',
					sublabel: null,
					kind: 'Go to',
					run: navigate(`/stories/${storyRef}/settings`)
				},
				{
					label: 'Review feedback',
					sublabel: null,
					kind: 'Go to',
					run: navigate(`/stories/${storyRef}/review`)
				}
			);
		}
		if (universeMatch) {
			const universeRef = universeMatch[1];
			list.push(
				{
					label: 'Plan this universe',
					sublabel: null,
					kind: 'Go to',
					run: navigate(`/universes/${universeRef}/plan`)
				},
				{
					label: 'Universe insights',
					sublabel: null,
					kind: 'Go to',
					run: navigate(`/universes/${universeRef}/insights`)
				},
				{
					label: 'Universe settings',
					sublabel: null,
					kind: 'Go to',
					run: navigate(`/universes/${universeRef}`)
				}
			);
		}
		list.push(
			{ label: 'Library', sublabel: null, kind: 'Go to', run: navigate('/') },
			{ label: 'Account settings', sublabel: null, kind: 'Go to', run: navigate('/account') },
			{ label: 'Help', sublabel: null, kind: 'Go to', run: navigate('/docs') }
		);
		return list;
	});

	const matchingCommands = $derived(
		commands.filter((command) => command.label.toLowerCase().includes(query.trim().toLowerCase()))
	);

	const items = $derived.by((): Item[] => [
		...matchingCommands,
		...results.map((result) => ({
			label: result.label,
			sublabel: result.sublabel,
			kind: TYPE_LABELS[result.type] ?? result.type,
			run: navigate(result.href)
		}))
	]);

	function search() {
		clearTimeout(searchTimer);
		const value = query.trim();
		if (value === '') {
			results = [];
			selected = 0;
			return;
		}
		searchTimer = setTimeout(async () => {
			const response = await fetch(`/api/search?q=${encodeURIComponent(value)}`);
			if (!response.ok) return;
			results = (await response.json()).results;
			selected = 0;
		}, 150);
	}

	function onGlobalKey(event: KeyboardEvent) {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			if (palette.open) closePalette();
			else openPalette();
		}
	}

	function onPaletteKey(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			closePalette();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			selected = Math.min(selected + 1, items.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void items[selected]?.run();
		}
	}

	$effect(() => {
		if (palette.open) {
			query = '';
			results = [];
			selected = 0;
			inputEl?.focus();
		}
	});
</script>

<svelte:window onkeydown={onGlobalKey} />

{#if palette.open}
	<div
		class="palette-backdrop"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) closePalette();
		}}
	>
		<div class="palette" role="dialog" aria-label="Command palette">
			<input
				bind:this={inputEl}
				bind:value={query}
				oninput={search}
				onkeydown={onPaletteKey}
				class="palette-input"
				type="text"
				placeholder="Search, or type a command..."
				aria-label="Search everything"
			/>
			<div class="palette-list" role="listbox" aria-label="Results">
				{#each items as item, index (item.kind + item.label + (item.sublabel ?? ''))}
					<button
						class="palette-item"
						class:active={index === selected}
						role="option"
						aria-selected={index === selected}
						type="button"
						onmouseenter={() => (selected = index)}
						onclick={() => void item.run()}
					>
						<span class="palette-kind">{item.kind}</span>
						<span class="palette-label">{item.label}</span>
						{#if item.sublabel}
							<span class="palette-sub">{item.sublabel}</span>
						{/if}
					</button>
				{/each}
				{#if items.length === 0}
					<p class="palette-none">Nothing matches.</p>
				{/if}
			</div>
			<div class="palette-foot">
				<span><kbd>&uarr;</kbd><kbd>&darr;</kbd> to choose</span>
				<span><kbd>Enter</kbd> to open</span>
				<span><kbd>Esc</kbd> to close</span>
			</div>
		</div>
	</div>
{/if}

<style>
	.palette-backdrop {
		position: fixed;
		inset: 0;
		background: color-mix(in oklab, var(--bg-canvas) 55%, transparent);
		backdrop-filter: blur(2px);
		z-index: 80;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 14vh;
	}
	.palette {
		width: min(560px, calc(100vw - 32px));
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		overflow: hidden;
		font-family: var(--font-ui);
	}
	.palette-input {
		width: 100%;
		border: 0;
		border-bottom: 1px solid var(--border);
		background: none;
		color: var(--text);
		font-size: 15px;
		padding: 14px 16px;
		outline: none;
	}
	.palette-input::placeholder {
		color: var(--text-faint);
	}
	.palette-list {
		max-height: 320px;
		overflow-y: auto;
		padding: 6px;
	}
	.palette-item {
		display: flex;
		align-items: baseline;
		gap: 10px;
		width: 100%;
		border: 0;
		background: none;
		color: var(--text);
		text-align: left;
		font-size: 13.5px;
		padding: 8px 10px;
		border-radius: 7px;
		cursor: pointer;
	}
	.palette-item.active {
		background: var(--bg-hover);
	}
	.palette-kind {
		flex: 0 0 72px;
		font-size: 10.5px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.palette-label {
		font-weight: 550;
	}
	.palette-sub {
		color: var(--text-faint);
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.palette-none {
		color: var(--text-faint);
		font-size: 13px;
		padding: 10px 12px;
		margin: 0;
	}
	.palette-foot {
		display: flex;
		gap: 14px;
		border-top: 1px solid var(--border);
		color: var(--text-faint);
		font-size: 11.5px;
		padding: 8px 14px;
	}
	.palette-foot kbd {
		font-family: var(--font-mono);
		font-size: 10.5px;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 0 4px;
		margin-right: 2px;
	}
</style>
