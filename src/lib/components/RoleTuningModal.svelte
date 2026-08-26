<script lang="ts">
	import {
		EFFORT_LEVELS,
		MAX_REPLY_TOKENS,
		MAX_TEMPERATURE,
		TEMPERATURE_STEP,
		defaultMaxTokens,
		type AssistantRole,
		type RoleTuning
	} from '$lib/assistant-tuning';

	// Everything one Assistant role can be tuned to, with room for each control
	// to carry its own explanation. The account page renders this inside the
	// form that saves the role table, so the fields below submit with it; the
	// controls are named exactly as they were when they sat in the table row.
	//
	// The page saves on change, but this modal does not: a slider passes through
	// dozens of values on the way to the one you want, and each would be a save.
	// Changes inside the panel are held back (the handlers on the panel stop
	// them reaching the form) and the whole form is submitted once, by the page,
	// when the modal closes. Every way out closes the same way, so an edit is
	// never lost to Escape.

	let {
		role,
		saved,
		anthropic,
		contextWindow,
		onClose
	}: {
		role: { id: AssistantRole; name: string; hint: string; suggestion: string };
		saved: RoleTuning;
		// Claude reads effort and ignores temperature and extra settings; every
		// other endpoint is the other way round. Show only what will be read.
		anthropic: boolean;
		// The chosen model's context window, when the endpoint reported one or
		// the writer typed one: it bounds the reply-length slider.
		contextWindow: number | undefined;
		// True when something in the panel was touched, so a look-and-close does
		// not write the config or report a save that changed nothing.
		onClose: (changed: boolean) => void;
	} = $props();

	// A fresh modal per open, so the saved values are a starting point rather
	// than something to keep in step.
	// svelte-ignore state_referenced_locally
	let temperature = $state<number | null>(saved.temperature ?? null);
	// svelte-ignore state_referenced_locally
	let maxTokens = $state<number | null>(saved.maxTokens ?? null);

	// Where a slider starts when you take the value off its default. Temperature
	// begins at the midpoint, which is also what most endpoints use.
	const TEMPERATURE_START = 1;
	const codexMaxTokens = $derived(defaultMaxTokens(role.id));
	// Arrow keys and drags land on round numbers; the box beside them still
	// takes any figure you type.
	const MAX_TOKENS_STEP = 128;
	// A model can never write more than its context window holds, so that is the
	// top of the slider when it is known.
	const maxTokensCeiling = $derived(
		Math.max(Math.min(contextWindow ?? MAX_REPLY_TOKENS, MAX_REPLY_TOKENS), MAX_TOKENS_STEP)
	);

	// Focus lands on the panel, so the dialog is announced and Escape works
	// before anything inside has been touched. The page returns focus to the
	// button that opened it.
	let panelEl = $state<HTMLDivElement>();
	$effect(() => panelEl?.focus());

	let changed = $state(false);
	let extraEl = $state<HTMLTextAreaElement>();

	// A number outside its bounds, or extra settings that are not JSON, would be
	// thrown away by a save that closed over them, so closing stops and the
	// browser points at the field instead. The server still owns the rules; this
	// only catches what it would reject after the panel had gone.
	function requestClose() {
		if (extraEl) {
			let problem = '';
			try {
				if (extraEl.value.trim()) JSON.parse(extraEl.value);
			} catch {
				problem = 'Extra settings must be JSON, for example {"top_p": 0.9}.';
			}
			extraEl.setCustomValidity(problem);
		}
		const invalid = panelEl?.querySelector<HTMLInputElement | HTMLTextAreaElement>(':invalid');
		if (invalid) {
			invalid.reportValidity();
			return;
		}
		onClose(changed);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			requestClose();
		}
	}
</script>

<div
	class="modal-backdrop"
	role="presentation"
	onclick={(event) => {
		if (event.target === event.currentTarget) requestClose();
	}}
	onkeydown={onKeydown}
>
	<div
		class="modal-panel modal-lg"
		bind:this={panelEl}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
		aria-label="Tune {role.name}"
		onchange={(event) => {
			event.stopPropagation();
			changed = true;
		}}
		oninput={() => (changed = true)}
	>
		<div class="modal-head">
			<div class="modal-head-main">
				<h2 class="modal-title">{role.name}</h2>
				<p class="modal-sub">{role.hint} {role.suggestion}</p>
			</div>
		</div>

		<div class="modal-body">
			<div class="field">
				<label for="tune-thinking">Thinking</label>
				<select
					id="tune-thinking"
					class="select"
					name="{role.id}-thinking"
					value={saved.thinking === true ? 'on' : saved.thinking === false ? 'off' : ''}
				>
					<option value="">Endpoint default</option>
					<option value="on">On</option>
					<option value="off">Off</option>
				</select>
				<p class="field-hint">
					Thinking lets the model reason before it answers: better feedback, slower and more tokens.
					Turn it off for a role that needs to be quick.
				</p>
			</div>

			{#if anthropic}
				<div class="field">
					<label for="tune-effort">Effort</label>
					<select
						id="tune-effort"
						class="select"
						name="{role.id}-effort"
						value={saved.effort ?? ''}
					>
						<option value="">Endpoint default</option>
						{#each EFFORT_LEVELS as level (level)}
							<option value={level}>{level}</option>
						{/each}
					</select>
					<p class="field-hint">
						How hard the model works on each request. Lighter or older models may not accept every
						level: if a request fails, set this back to the default. "xhigh" needs a recent Opus
						model.
					</p>
				</div>
			{:else}
				<div class="field">
					<label for="tune-temperature">Temperature</label>
					<label class="check-row">
						<input
							type="checkbox"
							checked={temperature === null}
							onchange={(event) =>
								(temperature = event.currentTarget.checked ? null : TEMPERATURE_START)}
						/>
						Use the endpoint default
					</label>
					<div class="slider-row" class:muted={temperature === null}>
						<input
							class="slider"
							type="range"
							min="0"
							max={MAX_TEMPERATURE}
							step={TEMPERATURE_STEP}
							value={temperature ?? TEMPERATURE_START}
							disabled={temperature === null}
							aria-label="Temperature slider"
							oninput={(event) =>
								(temperature = Math.round(Number(event.currentTarget.value) * 100) / 100)}
						/>
						<input
							id="tune-temperature"
							class="input slider-value"
							type="number"
							min="0"
							max={MAX_TEMPERATURE}
							step="any"
							name="{role.id}-temperature"
							bind:value={temperature}
							placeholder="Default"
						/>
					</div>
					<p class="field-hint">
						How freely the model varies its wording, from 0 to 2. Lower is more precise and
						repeatable, higher is more surprising. The reviewer works best low, around 0.2. Drag the
						slider or type an exact figure.
					</p>
				</div>
			{/if}

			<div class="field">
				<label for="tune-max-tokens">Longest reply</label>
				<label class="check-row">
					<input
						type="checkbox"
						checked={maxTokens === null}
						onchange={(event) => (maxTokens = event.currentTarget.checked ? null : codexMaxTokens)}
					/>
					Use the Codex default ({codexMaxTokens.toLocaleString()} tokens)
				</label>
				<div class="slider-row" class:muted={maxTokens === null}>
					<input
						class="slider"
						type="range"
						min={MAX_TOKENS_STEP}
						max={maxTokensCeiling}
						step={MAX_TOKENS_STEP}
						value={maxTokens ?? codexMaxTokens}
						disabled={maxTokens === null}
						aria-label="Longest reply slider"
						oninput={(event) => (maxTokens = Number(event.currentTarget.value))}
					/>
					<input
						id="tune-max-tokens"
						class="input slider-value"
						type="number"
						min="1"
						max={MAX_REPLY_TOKENS}
						step="1"
						name="{role.id}-maxTokens"
						bind:value={maxTokens}
						placeholder="Default"
					/>
				</div>
				<p class="field-hint">
					The most this role may write in one go, counted in tokens. Raise it if replies get cut off
					mid-sentence, lower it to keep them brief.
					{#if contextWindow}
						The slider stops at this model's context window, {contextWindow.toLocaleString()} tokens.
					{/if}
				</p>
			</div>

			{#if !anthropic}
				<div class="field">
					<label for="tune-extra">Extra settings</label>
					<textarea
						bind:this={extraEl}
						id="tune-extra"
						class="textarea json-field"
						name="{role.id}-extraParams"
						rows="3"
						spellcheck="false"
						autocomplete="off"
						placeholder={'{"top_p": 0.9}'}
						value={saved.extraParams && Object.keys(saved.extraParams).length > 0
							? JSON.stringify(saved.extraParams, null, 2)
							: ''}></textarea>
					<p class="field-hint">
						JSON sent with this role's requests only, laid over the settings on your endpoint. Use
						it when one role needs something different, such as a switch that turns reasoning off
						for the reviewer. Check your server's documentation for what it accepts, and leave it
						empty if you are not sure.
					</p>
				</div>
			{/if}
		</div>

		<div class="modal-foot">
			<div class="modal-foot-note">Saved when you close this.</div>
			<button class="btn btn-sm btn-primary" type="button" onclick={requestClose}>Done</button>
		</div>
	</div>
</div>

<style>
	.slider-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-top: 8px;
	}
	.slider-row :global(.slider) {
		flex: 1;
		min-width: 0;
	}
	.slider-row.muted {
		opacity: 0.5;
	}
	.slider-value {
		flex: none;
		width: 108px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	/* JSON, not prose: the .textarea content face would render it in the
	   editor's reading font. */
	.json-field {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
</style>
