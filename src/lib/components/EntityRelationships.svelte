<script lang="ts" module>
	export type RelationTypeOption = {
		id: string;
		forwardLabel: string;
		fromType: string;
		toType: string;
		category: string | null;
	};
	export type RelationshipRow = {
		id: string;
		label: string;
		otherId: string;
		otherName: string;
		notesMd: string | null;
	};
</script>

<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { entityColor } from '$lib/entity-color';
	import { post } from '$lib/api';
	import type { EntityKind } from './EntityEditor.svelte';

	// The typed relationships block: the existing rows and the add form.
	// Relationships are added and removed one at a time, not part of the
	// entity's debounced field autosave.
	let {
		kind,
		entityId,
		relationTypes = [],
		relationships = [],
		targets = {},
		entityHref
	}: {
		kind: EntityKind;
		entityId: string;
		relationTypes?: RelationTypeOption[];
		relationships?: RelationshipRow[];
		// Entities a relationship can point at, keyed by entity type.
		targets?: Record<string, { id: string; name: string }[]>;
		// Builds the Plan link for a related entity, scoped to story or universe.
		entityHref?: (entityId: string) => string;
	} = $props();

	// svelte-ignore state_referenced_locally
	const ENTITY_TYPE = kind === 'lore' ? 'lore_entry' : kind;
	const applicableTypes = $derived(
		relationTypes.filter((relationType) => relationType.fromType === ENTITY_TYPE)
	);
	const relCategories = $derived([
		...new Set(applicableTypes.map((relationType) => relationType.category))
	]);

	let addingRel = $state(false);
	let relTypeId = $state('');
	let relTargetId = $state('');
	let relNotes = $state('');
	let relError = $state('');

	function cancelRelationship() {
		addingRel = false;
		relTypeId = '';
		relTargetId = '';
		relNotes = '';
		relError = '';
	}
	function onRelKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') cancelRelationship();
	}
	const relTargetOptions = $derived.by(() => {
		const relationType = relationTypes.find((option) => option.id === relTypeId);
		if (!relationType) return [];
		return (targets[relationType.toType] ?? []).filter((target) => target.id !== entityId);
	});

	async function addRelationship(event: SubmitEvent) {
		event.preventDefault();
		relError = '';
		const result = await post(
			'/api/relationships',
			{
				fromKind: kind,
				fromId: entityId,
				relationTypeId: relTypeId,
				toId: relTargetId,
				notesMd: relNotes
			},
			'Could not add that.'
		);
		if (!result.ok) {
			relError = result.message;
			return;
		}
		relTypeId = '';
		relTargetId = '';
		relNotes = '';
		addingRel = false;
		await invalidateAll();
	}

	async function removeRelationship(relationshipId: string) {
		const response = await fetch(`/api/relationships/${relationshipId}`, { method: 'DELETE' });
		if (response.ok) await invalidateAll();
	}
</script>

{#if applicableTypes.length > 0 || relationships.length > 0}
	<div class="section-label">Relationships</div>
	{#if relationships.length > 0}
		<div class="rel-list">
			{#each relationships as relationship (relationship.id)}
				<div class="rel-row">
					<span class="rel-type">{relationship.label}</span>
					{#if entityHref}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve (caller passes a resolved Plan path plus a query string) -->
						<a class="rel-target" href={entityHref(relationship.otherId)}>
							<span class="badge dot" style="background: {entityColor(relationship.otherName)}"
							></span>
							<span>{relationship.otherName}</span>
						</a>
					{:else}
						<span class="rel-target">
							<span class="badge dot" style="background: {entityColor(relationship.otherName)}"
							></span>
							<span>{relationship.otherName}</span>
						</span>
					{/if}
					{#if relationship.notesMd}
						<span class="rel-note">{relationship.notesMd}</span>
					{/if}
					<button
						class="icon-btn sm danger"
						type="button"
						title="Remove relationship"
						onclick={() => removeRelationship(relationship.id)}
					>
						&times;
					</button>
				</div>
			{/each}
		</div>
	{/if}
	{#if applicableTypes.length > 0}
		{#if addingRel}
			<form class="rel-add" onsubmit={addRelationship}>
				<select
					class="line-input"
					bind:value={relTypeId}
					onchange={() => (relTargetId = '')}
					onkeydown={onRelKeydown}
					aria-label="Relation"
				>
					<option value="">Pick a relationship...</option>
					{#each relCategories as category (category)}
						<optgroup label={category ?? 'Other'}>
							{#each applicableTypes.filter((option) => option.category === category) as option (option.id)}
								<option value={option.id}>{option.forwardLabel}</option>
							{/each}
						</optgroup>
					{/each}
				</select>
				{#if relTypeId}
					<select
						class="line-input"
						bind:value={relTargetId}
						onkeydown={onRelKeydown}
						aria-label="Related entity"
					>
						<option value="">Who or where...</option>
						{#each relTargetOptions as target (target.id)}
							<option value={target.id}>{target.name}</option>
						{/each}
					</select>
					<input
						class="line-input"
						type="text"
						placeholder="Notes (optional)"
						bind:value={relNotes}
						onkeydown={onRelKeydown}
					/>
				{/if}
				<div class="rel-add-actions">
					<button class="outline-add" type="submit" disabled={!relTargetId}>Add</button>
					<button class="rel-cancel" type="button" onclick={cancelRelationship}> Cancel </button>
				</div>
				{#if relError}
					<p class="rel-error" role="alert">{relError}</p>
				{/if}
			</form>
		{:else}
			<button type="button" class="chip dashed rel-add-chip" onclick={() => (addingRel = true)}>
				+ Add relationship
			</button>
		{/if}
	{/if}
{/if}

<style>
	.rel-add {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 10px;
	}
	.rel-add-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.rel-cancel {
		border: 0;
		background: none;
		color: var(--text-muted);
		font-size: 12.5px;
		padding: 5px 8px;
		cursor: pointer;
	}
	.rel-cancel:hover {
		color: var(--text);
	}
	.rel-add-chip {
		margin-top: 10px;
	}
	.rel-error {
		color: var(--danger, #b00020);
		font-size: 12.5px;
		margin: 0;
	}
</style>
