<script lang="ts">
	import { formatNumber } from '#lib/format';
	import { NO_PRICE_NOTE, capNotAppliedNote, money, overWarnNote } from '#lib/cost-notes';
	import type { SceneDraftEstimate } from '#lib/scene-draft';
	import FormStatus from './FormStatus.svelte';

	// What a scene or chapter draft would send and cost, shown before it runs.
	let {
		estimate,
		scenes,
		capAdvice
	}: {
		estimate: SceneDraftEstimate;
		// How many scenes the run drafts, for a chapter.
		scenes?: number;
		// What to do about an estimate over the spend cap.
		capAdvice: string;
	} = $props();

	const phrase = $derived.by(() => {
		const lead =
			scenes === undefined
				? 'This sends'
				: `This drafts ${scenes} ${scenes === 1 ? 'scene' : 'scenes'}. It sends`;
		const size = `${lead} about ${formatNumber(estimate.estTokens)} tokens and writes up to ${formatNumber(estimate.estCompletionTokens)}`;
		if (estimate.estCostUsd === undefined) return `${size}.`;
		return estimate.estCostUsd < 0.01
			? `${size} (less than $0.01).`
			: `${size} (up to $${money(estimate.estCostUsd)}).`;
	});
	const each = $derived(scenes === undefined ? 'this draft' : 'each scene');
</script>

<div class="assist-card-stack" role="status">
	<p class="assist-card-note">{phrase}</p>
	<p class="assist-card-note">
		{#if estimate.mayThink}
			Your model may think before it writes, and thinking is charged like writing, so it may use
			most of that.
		{:else}
			That is the most the reply can be. A scene of the length you asked for usually takes less.
		{/if}
	</p>
	{#if estimate.estCostUsd === undefined}
		<p class="assist-card-note">{NO_PRICE_NOTE}</p>
	{/if}
	{#if estimate.capUsd !== undefined && !estimate.capEnforceable}
		<p class="assist-card-note">{capNotAppliedNote(estimate.capUsd)}</p>
	{/if}
	{#if !estimate.overCap}
		{#if estimate.estCostUsd !== undefined && estimate.estCostUsd > estimate.warnUsd}
			<p class="assist-card-note">{overWarnNote(estimate.warnUsd)}</p>
		{/if}
		{#if estimate.limitedToWords !== undefined && estimate.limitedBy === 'setting'}
			<p class="assist-card-note">
				The reply length set for Write stops {each} at about {formatNumber(estimate.limitedToWords)}
				words. To draft more, raise Longest reply for Write in its Tune window under Account, Assistant.
			</p>
		{:else if estimate.limitedToWords !== undefined}
			<p class="assist-card-note">
				Your model can write about {formatNumber(estimate.limitedToWords)} words in one reply, so {each}
				stops there. Ask for a shorter length, or use a model that can write longer replies.
			</p>
		{/if}
	{/if}
</div>
{#if estimate.overCap && estimate.capUsd !== undefined}
	<FormStatus
		block
		error={`That is over your spend cap of $${money(estimate.capUsd)}, so the draft will not run. ${capAdvice}`}
	/>
{/if}
