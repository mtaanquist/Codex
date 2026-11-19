<script lang="ts">
	// The composer's "Add context" picker: search the library for a scene,
	// chapter, character, place, lore entry, note or story to send with the next
	// message. A story opens its own list: its outline, the whole book (with its
	// size, and its price where the endpoint reports one), or one of its chapters
	// or scenes. Focus stays in the search field, which drives the list.
	import type { AttachmentKind, ChatAttachment } from '#lib/assistant-chat';
	import { formatNumber } from '#lib/format';
	import Icon from './Icon.svelte';

	type Item = { kind: AttachmentKind; id: string; label: string; sublabel: string | null };
	type StoryContents = {
		label: string;
		words: number;
		usd: number | null;
		chapters: Item[];
		scenes: Item[];
	};
	type Row = {
		key: string;
		group: string;
		label: string;
		sublabel: string | null;
		pick: () => void;
	};

	let {
		id,
		model,
		onAdd
	}: {
		// The listbox id, for the field's aria-controls.
		id: string;
		// The chat's model, so the whole book is priced on it.
		model: string | undefined;
		onAdd: (attachment: ChatAttachment) => void;
	} = $props();

	let query = $state('');
	let items = $state<Item[]>([]);
	let story = $state<{ id: string; label: string } | null>(null);
	let contents = $state<StoryContents | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let selected = $state(0);
	let field = $state<HTMLInputElement>();
	let list = $state<HTMLDivElement>();

	const KIND_GROUPS: Record<AttachmentKind, string> = {
		story: 'Stories',
		chapter: 'Chapters',
		scene: 'Scenes',
		entity: 'Characters, places and lore',
		note: 'Notes'
	};

	// The search, refetched as the query changes (debounced), while no story is
	// open. The old results go at once, so Enter cannot pick from a stale list.
	$effect(() => {
		if (story) return;
		const q = query;
		const controller = new AbortController();
		items = [];
		loading = true;
		failed = false;
		const timer = setTimeout(async () => {
			try {
				const response = await fetch(`/api/assistant/context?q=${encodeURIComponent(q)}`, {
					signal: controller.signal
				});
				if (!response.ok) throw new Error('failed');
				const found = ((await response.json()) as { items: Item[] }).items;
				if (controller.signal.aborted) return;
				items = found;
				failed = false;
			} catch {
				if (controller.signal.aborted) return;
				items = [];
				failed = true;
			}
			loading = false;
		}, 150);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	// One story's parts, loaded when it is opened.
	$effect(() => {
		if (!story) return;
		const storyId = story.id;
		const controller = new AbortController();
		loading = true;
		const modelParam = model ? `&model=${encodeURIComponent(model)}` : '';
		fetch(`/api/assistant/context?storyId=${storyId}${modelParam}`, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error('failed');
				const found = (await response.json()) as StoryContents;
				if (controller.signal.aborted) return;
				contents = found;
				failed = false;
			})
			.catch(() => {
				if (controller.signal.aborted) return;
				contents = null;
				failed = true;
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});

	function add(item: Item, depth?: 'outline' | 'book') {
		onAdd({ kind: item.kind, id: item.id, label: item.label, ...(depth ? { depth } : {}) });
	}

	function openStory(item: Item) {
		story = { id: item.id, label: item.label };
		contents = null;
		query = '';
		selected = 0;
		field?.focus();
	}

	function back() {
		story = null;
		contents = null;
		query = '';
		selected = 0;
		field?.focus();
	}

	function bookSize(c: StoryContents): string {
		const words = `about ${formatNumber(c.words)} words`;
		if (c.usd === null) return words;
		const cost = c.usd < 0.01 ? 'under $0.01' : `about $${c.usd.toFixed(2)}`;
		return `${words}, ${cost} each time it is sent`;
	}

	const rows = $derived.by((): Row[] => {
		if (!story) {
			return items.map((item) => ({
				key: `${item.kind}-${item.id}`,
				group: KIND_GROUPS[item.kind],
				label: item.label,
				sublabel: item.sublabel,
				pick: () => (item.kind === 'story' ? openStory(item) : add(item))
			}));
		}
		if (!contents) return [];
		const opened = { kind: 'story' as const, id: story.id, label: story.label, sublabel: null };
		const q = query.trim().toLowerCase();
		const matches = (item: Item) => !q || item.label.toLowerCase().includes(q);
		const whole: Row[] = [
			{
				key: 'outline',
				group: 'The story',
				label: 'Outline and summaries',
				sublabel: 'Chapter and scene titles with their summaries',
				pick: () => add(opened, 'outline')
			},
			{
				key: 'book',
				group: 'The story',
				label: 'Whole book',
				sublabel: bookSize(contents),
				pick: () => add(opened, 'book')
			}
		];
		return [
			...(q ? [] : whole),
			...contents.chapters.filter(matches).map((item) => ({
				key: `chapter-${item.id}`,
				group: 'Chapters',
				label: item.label,
				sublabel: item.sublabel,
				pick: () => add(item)
			})),
			...contents.scenes.filter(matches).map((item) => ({
				key: `scene-${item.id}`,
				group: 'Scenes',
				label: item.label,
				sublabel: item.sublabel,
				pick: () => add(item)
			}))
		];
	});

	const sections = $derived.by(() => {
		const out: { group: string; rows: { row: Row; index: number }[] }[] = [];
		rows.forEach((row, index) => {
			const last = out[out.length - 1];
			if (last && last.group === row.group) last.rows.push({ row, index });
			else out.push({ group: row.group, rows: [{ row, index }] });
		});
		return out;
	});

	$effect(() => {
		if (selected >= rows.length) selected = 0;
	});
	$effect(() => {
		void selected;
		list?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
	});
	$effect(() => {
		field?.focus();
	});

	function onKeydown(event: KeyboardEvent) {
		const count = rows.length;
		if (event.key === 'ArrowDown' && count > 0) {
			selected = (selected + 1) % count;
		} else if (event.key === 'ArrowUp' && count > 0) {
			selected = (selected - 1 + count) % count;
		} else if (event.key === 'Enter' && count > 0) {
			rows[selected].pick();
		} else if (event.key === 'Backspace' && story && query === '') {
			back();
		} else if (event.key === 'Escape') {
			// The panel's dismiss handles Escape and returns focus to the trigger.
			return;
		} else {
			return;
		}
		event.preventDefault();
	}

	const slug = (key: string) => `${id}-${key}`;
</script>

<div class="context-picker popover">
	{#if story}
		<div class="picker-head">
			<button
				class="icon-btn sm"
				type="button"
				title="Back to search"
				aria-label="Back to search"
				onclick={back}
			>
				<Icon name="chevron" size={14} />
			</button>
			<span class="picker-title">{story.label}</span>
		</div>
	{/if}
	<input
		bind:this={field}
		class="picker-search"
		type="text"
		placeholder={story ? 'Filter chapters and scenes' : 'Search scenes, characters, notes, stories'}
		aria-label={story ? 'Filter chapters and scenes' : 'Search for context to add'}
		role="combobox"
		aria-expanded={rows.length > 0}
		aria-controls={id}
		aria-autocomplete="list"
		aria-activedescendant={rows[selected] ? slug(rows[selected].key) : undefined}
		bind:value={query}
		oninput={() => (selected = 0)}
		onkeydown={onKeydown}
	/>
	<div class="picker-list" {id} role="listbox" aria-label="Context to add" bind:this={list}>
		{#each sections as section (section.group)}
			<div role="group" aria-label={section.group}>
				<div class="picker-group" aria-hidden="true">{section.group}</div>
				{#each section.rows as { row, index } (row.key)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						id={slug(row.key)}
						class="menu-item picker-row"
						class:active={index === selected}
						role="option"
						tabindex="-1"
						aria-selected={index === selected}
						onmousedown={(event) => event.preventDefault()}
						onmouseenter={() => (selected = index)}
						onclick={row.pick}
					>
						<span class="picker-label">{row.label}</span>
						{#if row.sublabel}<span class="picker-sub">{row.sublabel}</span>{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="picker-empty" role="status">
				{#if loading}
					Loading...
				{:else if failed}
					Could not load the list. Try again in a moment.
				{:else if story}
					Nothing in this story matches.
				{:else if query.trim()}
					Nothing matches.
				{:else}
					Your stories will be listed here.
				{/if}
			</p>
		{/each}
	</div>
</div>

<style>
	.context-picker {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: min(380px, 60vh);
	}
	.picker-head {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.picker-head :global(svg) {
		transform: rotate(180deg);
	}
	.picker-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.picker-search {
		width: 100%;
		font: inherit;
		font-size: var(--text-base);
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-card);
		color: var(--text);
	}
	.picker-search:focus {
		outline: none;
		border-color: var(--accent-line);
	}
	.picker-list {
		overflow-y: auto;
		min-height: 0;
	}
	.picker-group {
		padding: 8px 7px 3px;
		font-size: var(--text-micro);
		color: var(--text-faint);
	}
	.picker-row {
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		cursor: pointer;
	}
	.picker-label,
	.picker-sub {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.picker-sub {
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.picker-empty {
		margin: 6px 7px;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
</style>
