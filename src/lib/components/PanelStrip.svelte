<script lang="ts">
	import { panelDomId, tabDomId, type Panel, type PanelId } from '$lib/panels';
	import type { Snippet } from 'svelte';

	// The right pane's header and its panels. Two or more panels make a real
	// tablist: one tab stop for the strip, left and right arrows between panels,
	// Home and End to the ends. One panel is not a control, so the pane wears a
	// title instead. No panels at all means the caller should not render a pane.
	let {
		panels,
		active,
		onSelect,
		label = 'Panels about this document',
		sub,
		panel
	}: {
		panels: Panel[];
		active: PanelId;
		onSelect: (id: PanelId) => void;
		// The tablist's accessible name.
		label?: string;
		// What the single panel is about ("this note"), shown beside its title.
		sub?: string;
		// The contents of a panel, rendered only while it is the open one.
		panel: Snippet<[PanelId]>;
	} = $props();

	let tabs: Record<string, HTMLButtonElement | undefined> = $state({});

	function move(from: PanelId, key: string) {
		const index = panels.findIndex((p) => p.id === from);
		if (index < 0) return null;
		if (key === 'ArrowRight' || key === 'ArrowDown') return panels[(index + 1) % panels.length];
		if (key === 'ArrowLeft' || key === 'ArrowUp')
			return panels[(index - 1 + panels.length) % panels.length];
		if (key === 'Home') return panels[0];
		if (key === 'End') return panels[panels.length - 1];
		return null;
	}

	function onKeydown(event: KeyboardEvent, id: PanelId) {
		const next = move(id, event.key);
		if (!next) return;
		event.preventDefault();
		onSelect(next.id);
		tabs[next.id]?.focus();
	}
</script>

<div class="right-head">
	{#if panels.length > 1}
		<div class="seg full panel-strip" role="tablist" aria-label={label}>
			{#each panels as tab (tab.id)}
				<button
					bind:this={tabs[tab.id]}
					class="seg-btn"
					class:active={active === tab.id}
					type="button"
					role="tab"
					id={tabDomId(tab.id)}
					aria-controls={panelDomId(tab.id)}
					aria-selected={active === tab.id}
					tabindex={active === tab.id ? 0 : -1}
					onclick={() => onSelect(tab.id)}
					onkeydown={(event) => onKeydown(event, tab.id)}
				>
					{tab.label}{#if tab.count !== undefined && tab.count > 0}<span class="seg-count"
							>{tab.count}</span
						>{/if}
				</button>
			{/each}
		</div>
	{:else if panels.length === 1}
		<div class="panel-head">
			<h2 class="panel-head-title">{panels[0].label}</h2>
			{#if sub}<span class="panel-head-sub">{sub}</span>{/if}
		</div>
	{/if}
</div>

{#each panels as body (body.id)}
	<!-- The wrapper stays so aria-controls always points at something; only the
	     open panel's contents are built, so a chat or a revision list is not
	     fetched until it is looked at. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (a tab panel is the one
	     place a nonnegative tabindex belongs; it is only set with the role) -->
	<div
		class="panel-body"
		id={panelDomId(body.id)}
		role={panels.length > 1 ? 'tabpanel' : undefined}
		aria-labelledby={panels.length > 1 ? tabDomId(body.id) : undefined}
		tabindex={panels.length > 1 ? 0 : undefined}
		hidden={body.id !== active}
	>
		{#if body.id === active}{@render panel(body.id)}{/if}
	</div>
{/each}
