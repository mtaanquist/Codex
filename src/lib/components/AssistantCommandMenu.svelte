<script lang="ts">
	// The Assistant composer's command menu: every chat action, in sections,
	// for the "/" button and for a "/" typed in the composer. Focus stays in a
	// text field (the composer, or the menu's own filter when opened from the
	// button), which drives the list with aria-activedescendant; the panel owns
	// the query, the highlighted row, and the keys.
	import { ACTION_GROUPS, type SlashCommand } from '#lib/assistant-slash';

	let {
		id,
		commands,
		selected,
		onChoose,
		onHover,
		filter
	}: {
		// The listbox id, for the text field's aria-controls.
		id: string;
		// The matching commands, in ACTION_GROUPS order.
		commands: SlashCommand[];
		selected: number;
		onChoose: (command: SlashCommand) => void;
		onHover: (index: number) => void;
		// Present when the menu was opened from the button: it shows its own
		// filter field, wired to the panel's query and keys.
		filter?: {
			value: string;
			onInput: (value: string) => void;
			onKeydown: (event: KeyboardEvent) => void;
		};
	} = $props();

	const sections = $derived(
		ACTION_GROUPS.map((group) => ({
			...group,
			rows: commands
				.map((command, index) => ({ command, index }))
				.filter((row) => row.command.group === group.id)
		})).filter((section) => section.rows.length > 0)
	);

	let list = $state<HTMLDivElement>();
	let filterField = $state<HTMLInputElement>();

	$effect(() => {
		void selected;
		list?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
	});

	$effect(() => {
		filterField?.focus();
	});
</script>

<div class="command-menu popover">
	{#if filter}
		<input
			bind:this={filterField}
			class="command-filter"
			type="text"
			placeholder="Filter commands"
			aria-label="Filter commands"
			role="combobox"
			aria-expanded="true"
			aria-controls={id}
			aria-autocomplete="list"
			aria-activedescendant={commands[selected] ? `${id}-${commands[selected].name}` : undefined}
			value={filter.value}
			oninput={(event) => filter.onInput(event.currentTarget.value)}
			onkeydown={filter.onKeydown}
		/>
	{/if}
	<div class="command-list" {id} role="listbox" aria-label="Commands" bind:this={list}>
		{#each sections as section (section.id)}
			<div role="group" aria-labelledby="{id}-{section.id}">
				<div class="command-group" id="{id}-{section.id}">{section.label}</div>
				{#each section.rows as row (row.command.name)}
					<!-- Options take no focus: the text field keeps it and points at the
					     highlighted row, so the pointer only needs a click. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						id="{id}-{row.command.name}"
						class="menu-item command-row"
						class:active={row.index === selected}
						role="option"
						tabindex="-1"
						aria-selected={row.index === selected}
						title={row.command.detail}
						onmousedown={(event) => event.preventDefault()}
						onmouseenter={() => onHover(row.index)}
						onclick={() => onChoose(row.command)}
					>
						<span class="command-label">{row.command.label}</span>
						<span class="command-typed">/{row.command.name}</span>
					</div>
				{/each}
			</div>
		{:else}
			<p class="command-empty">No commands match.</p>
		{/each}
	</div>
</div>

<style>
	.command-menu {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: min(360px, 60vh);
	}
	.command-filter {
		width: 100%;
		font: inherit;
		font-size: var(--text-base);
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-card);
		color: var(--text);
	}
	.command-filter:focus {
		outline: none;
		border-color: var(--accent-line);
	}
	.command-list {
		overflow-y: auto;
		min-height: 0;
	}
	.command-group {
		padding: 8px 7px 3px;
		font-size: var(--text-micro);
		color: var(--text-faint);
	}
	.command-row {
		justify-content: space-between;
		cursor: pointer;
	}
	.command-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.command-typed {
		flex: none;
		font-family: var(--font-mono);
		font-size: var(--text-meta);
		color: var(--text-faint);
	}
	.command-empty {
		margin: 6px 7px;
		font-size: var(--text-sm);
		color: var(--text-faint);
	}
</style>
