<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { autosaveSubmit, autosubmitForm } from '$lib/autosave-form';
	import { pluralSuffix } from '$lib/format';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The Assistant's kill switch reads inverted: engaged (checked) means off.
	const assistantOff = $derived(!data.assistant.enabled);

	// Per-role model rows. The ids match the Assistant roles the gateway resolves
	// a model for; the copy is presentational. Model names live here and in the
	// help article, and nowhere else, so there are two places to refresh.
	const FAST_SUGGESTION =
		'Wants a fast model: hosted, Claude Haiku; on your own machine, a mixture-of-experts instruct model such as Qwen3 30B A3B (search for MoE instruct GGUF). Turn thinking off.';
	const ROLE_META = [
		{
			id: 'chat',
			name: 'Rubber duck',
			hint: 'Conversational side panel. Best with a smart, chatty model.',
			suggestion: 'Any model you like talking to.'
		},
		{
			id: 'coauthor',
			name: 'Co-author',
			hint: 'Generates passages you can insert or edit. Prefer strong prose quality.',
			suggestion: FAST_SUGGESTION
		},
		{
			id: 'continuation',
			name: 'Continuation',
			hint: 'Inline ghost-text suggestions. Fast and light is what matters.',
			suggestion: FAST_SUGGESTION
		},
		{
			id: 'reviewer',
			name: 'Reviewer',
			hint: 'Reads a draft and leaves suggested edits in your name.',
			suggestion:
				'Wants the strongest model you can run: hosted, Claude Sonnet; on your own machine, a dense 32B instruct model such as Qwen3 32B (search for 32B instruct GGUF). Set a low temperature; thinking is optional.'
		},
		{
			id: 'utility',
			name: 'Background work',
			hint: 'Summaries, suggested entity details, and recaps. Runs while you work.',
			suggestion: 'Use the same fast models as Continuation, with thinking off.'
		}
	] as const;

	// The model dropdowns offer whatever the last discovery returned, unioned with
	// any model already chosen, so a saved pick always shows even before a refresh.
	// A filter box narrows large catalogues (OpenRouter lists hundreds); saved
	// picks always stay in the list so a save never silently drops one.
	type DiscoveredModel = {
		id: string;
		pricing?: { prompt: number; completion: number };
		contextLength?: number;
	};
	const savedModels = $derived(data.assistant.models as Record<string, string | undefined>);

	// Per-role tuning. Thinking and temperature apply to every provider; the
	// effort levels are the Claude provider's own (mirrors EFFORT_LEVELS in
	// $lib/server/llm/config, which cannot be imported here).
	const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
	const savedTuning = $derived(
		data.assistant.tuning as Record<
			string,
			| {
					thinking?: boolean;
					effort?: string;
					temperature?: number;
					maxTokens?: number;
					extraParams?: Record<string, unknown>;
			  }
			| undefined
		>
	);
	// The thinking select is three-state: on, off, or the endpoint's default.
	function thinkingValue(role: string): string {
		const thinking = savedTuning[role]?.thinking;
		return thinking === true ? 'on' : thinking === false ? 'off' : '';
	}
	// A discovery result must outlive the action data that carried it: with
	// role picks saving on change, the next save would otherwise wipe the list
	// after the first pick.
	let discoveredModels = $state<DiscoveredModel[]>([]);
	$effect(() => {
		if (form?.scope === 'assistant-discover' && 'models' in form) {
			discoveredModels = form.models as DiscoveredModel[];
		}
	});
	let modelFilter = $state('');
	const modelOptions = $derived.by(() => {
		const filter = modelFilter.trim().toLowerCase();
		const ids = discoveredModels
			.map((m) => m.id)
			.filter((id) => !filter || id.toLowerCase().includes(filter));
		return [...new Set([...ids, ...Object.values(savedModels).filter((m): m is string => !!m)])];
	});
	// Per-token prices, from the last saved discovery snapshot overlaid with the
	// one just run; absent for endpoints that report none.
	const modelPricing = $derived({
		...(data.assistant.modelPricing ?? {}),
		...Object.fromEntries(discoveredModels.filter((m) => m.pricing).map((m) => [m.id, m.pricing!]))
	});
	function perMillion(perToken: number): string {
		const value = perToken * 1_000_000;
		return `$${value >= 100 ? value.toFixed(0) : value.toFixed(2)}`;
	}
	// Context windows: what the endpoint reported at the last discovery (or the
	// one just run), with anything typed here laid over it.
	const discoveredContext = $derived({
		...(data.assistant.modelContext ?? {}),
		...Object.fromEntries(
			discoveredModels.filter((m) => m.contextLength).map((m) => [m.id, m.contextLength!])
		)
	} as Record<string, number>);
	const manualContext = $derived(
		(data.assistant.modelContextManual ?? {}) as Record<string, number>
	);
	function contextWindow(id: string): number | undefined {
		return manualContext[id] ?? discoveredContext[id];
	}
	// The models with a context field: whatever is picked for a role right now.
	const chosenModels = $derived([
		...new Set(Object.values(savedModels).filter((m): m is string => !!m))
	]);
	function modelLabel(id: string): string {
		const price = modelPricing[id];
		const tokens = contextWindow(id);
		const parts = [
			price
				? `${perMillion(price.prompt)} in / ${perMillion(price.completion)} out per 1M tokens`
				: '',
			tokens ? `${tokens.toLocaleString()} token context` : ''
		].filter(Boolean);
		return parts.length > 0 ? `${id} (${parts.join(', ')})` : id;
	}
	function usageCost(model: string, promptTokens: number | null, completionTokens: number | null) {
		const price = modelPricing[model];
		if (!price || (promptTokens === null && completionTokens === null)) return null;
		return (promptTokens ?? 0) * price.prompt + (completionTokens ?? 0) * price.completion;
	}
	const usageTotalCost = $derived.by(() => {
		let total = 0;
		let known = false;
		for (const row of data.assistantUsage.byModel) {
			const cost = usageCost(row.model, row.promptTokens, row.completionTokens);
			if (cost !== null) {
				total += cost;
				known = true;
			}
		}
		return known ? total : null;
	});

	// The usage log pages through ?usage=N on the assistant section.
	function usagePageHref(n: number): string {
		const base = resolve('/account/[[section]]', { section: 'assistant' });
		return n > 0 ? `${base}?usage=${n}` : base;
	}

	// The provider picker: a preset prefills and locks the endpoint URL (the
	// server stores the preset's URL regardless); custom keeps the free field.
	// The initial value is intentionally a snapshot; the select owns it after.
	// svelte-ignore state_referenced_locally
	let selectedProvider = $state(data.assistant.provider);
	const activePreset = $derived(data.providers.find((p) => p.id === selectedProvider));
	// Extra request settings only reach an OpenAI-compatible endpoint; the Claude
	// provider has its own controls and ignores them, so the boxes stay hidden.
	const extraParamsShown = $derived(selectedProvider !== 'anthropic');
	function paramsText(params: Record<string, unknown> | undefined): string {
		return params && Object.keys(params).length > 0 ? JSON.stringify(params) : '';
	}
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Assistant</h1>
	<p class="admin-lede">
		Codex can lend a hand while you write, but only if you want it to. You decide whether it runs at
		all, what it is called, how it sounds, and where your words go.
	</p>
</div>

<div class="admin-block">
	<form method="POST" action="?/toggleAssistant">
		<div class="killswitch" class:engaged={assistantOff}>
			<span class="ks-ic"
				><svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></svg
				></span
			>
			<div class="ks-body">
				<div class="ks-titlerow">
					<span class="ks-title">Assistant kill switch</span>
					<span class="ks-status">{assistantOff ? 'Assistant off' : 'Assistant on'}</span>
				</div>
				<div class="ks-sub">
					While this is on, Codex never contacts a model: no suggestions, no analysis, nothing
					leaves your machine. Turn it off whenever you would like a hand; turn it back on and
					everything stops at once.
				</div>
				{#if form?.scope === 'assistant-kill' && form.message}
					<div class="ks-sub" role="alert" style="color:var(--danger);">
						{form.message}
					</div>
				{/if}
			</div>
			<label class="toggle toggle-xl">
				<input
					type="checkbox"
					name="killSwitch"
					value="on"
					aria-label="Assistant kill switch"
					checked={assistantOff}
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				/>
				<span class="toggle-track"></span>
			</label>
		</div>
	</form>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">How Codex uses your assistant</h2>
	</div>
	<div class="admin-card tight">
		<div class="attn-list">
			<div class="list-row">
				<span class="list-ic"
					><svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="m9 11 3 3L22 4" /><path
							d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
						/></svg
					></span
				>
				<div class="list-main">
					<div class="list-title">Only when you ask</div>
					<div class="list-sub">
						Help appears when you open the side panel, run a command, or accept an inline
						suggestion. Nothing is generated in the background.
					</div>
				</div>
			</div>
			<div class="list-row">
				<span class="list-ic"
					><svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						><rect x="3" y="11" width="18" height="11" rx="2" /><path
							d="M7 11V7a5 5 0 0 1 10 0v4"
						/></svg
					></span
				>
				<div class="list-main">
					<div class="list-title">Your words stay yours</div>
					<div class="list-sub">
						Text is sent only to the endpoint you set below, and is never used to train any model.
					</div>
				</div>
			</div>
			<div class="list-row">
				<span class="list-ic"
					><svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></svg
					></span
				>
				<div class="list-main">
					<div class="list-title">Off in one tap</div>
					<div class="list-sub">
						The kill switch above disables everything instantly, across every story you have open.
					</div>
				</div>
			</div>
		</div>
	</div>
</div>

<div data-ai-gated class:off={assistantOff}>
	<div class="admin-block">
		<div class="settings-group">
			<header class="settings-group-header">
				<h2 class="settings-group-title">Identity</h2>
				<p class="settings-group-subtitle">
					Give your assistant a name and a voice. It introduces itself this way in the side panel,
					and writes back in the tone you pick.
				</p>
			</header>
			<form
				method="POST"
				action="?/saveAssistantIdentity"
				use:enhance={autosaveSubmit}
				onchange={autosubmitForm}
			>
				<div class="field">
					<label for="assistant_name">Name</label>
					<input
						id="assistant_name"
						name="assistantName"
						type="text"
						class="input"
						maxlength="60"
						value={data.assistant.assistantName}
						placeholder="What should your assistant be called?"
					/>
					<p class="field-hint">Shown in the side-panel header and on any notes it leaves.</p>
				</div>
				<div class="field">
					<label for="assistant_style">Style</label>
					<select id="assistant_style" name="persona" class="select">
						{#each data.personas as preset (preset.id)}
							<option value={preset.id} selected={data.assistant.persona === preset.id}
								>{preset.label} - {preset.description}</option
							>
						{/each}
					</select>
					<p class="field-hint">
						Sets the assistant's default tone. Individual stories can override it.
					</p>
				</div>
				<div class="settings-actions">
					<FormStatus
						error={form?.scope === 'assistant-identity' && form.message ? form.message : null}
						success={form?.scope === 'assistant-identity' && form.saved ? 'Saved.' : null}
					/>
				</div>
			</form>
		</div>
	</div>

	<div class="admin-block">
		<div class="settings-group">
			<header class="settings-group-header">
				<h2 class="settings-group-title">Endpoint</h2>
				<p class="settings-group-subtitle">
					Pick a provider, or point at any OpenAI-compatible endpoint.
				</p>
			</header>
			<form
				method="POST"
				action="?/saveAssistantEndpoint"
				use:enhance={autosaveSubmit}
				onchange={autosubmitForm}
			>
				<div class="field">
					<label for="assistant_provider">Provider</label>
					<select
						id="assistant_provider"
						name="provider"
						class="select"
						bind:value={selectedProvider}
					>
						{#each data.providers as preset (preset.id)}
							<option value={preset.id}>{preset.label}</option>
						{/each}
						<option value="custom">Custom endpoint</option>
					</select>
					{#if activePreset}
						<p class="field-hint">
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external provider docs -->
							<a href={activePreset.docsUrl} target="_blank" rel="noopener noreferrer"
								>Get an API key</a
							>
							from {activePreset.label}.
						</p>
					{/if}
				</div>
				<div class="field">
					<label for="endpoint">Base URL</label>
					{#if activePreset}
						<input
							id="endpoint"
							name="endpoint"
							type="url"
							class="input"
							value={activePreset.baseUrl}
							readonly
						/>
						<p class="field-hint">Set by the provider you picked.</p>
					{:else}
						<input
							id="endpoint"
							name="endpoint"
							type="url"
							class="input"
							value={data.assistant.provider === 'custom' ? data.assistant.endpoint : ''}
							placeholder="http://ollama.local:11434/v1"
						/>
						<p class="field-hint">
							Example: <code style="font-family: var(--font-mono); font-size: 12px;"
								>http://ollama.local:11434/v1</code
							> for Ollama, or any other OpenAI-compatible endpoint.
						</p>
					{/if}
				</div>
				<div class="field">
					<label for="api_key">API key</label>
					<input
						id="api_key"
						name="apiKey"
						type="password"
						class="input"
						autocomplete="off"
						placeholder={data.assistant.hasKey
							? 'Saved. Leave blank to keep it.'
							: (activePreset?.keyHint ?? '')}
					/>
					<p class="field-hint">
						Leave blank to keep your saved key. Not every endpoint needs one.
					</p>
				</div>
				{#if extraParamsShown}
					<div class="field">
						<label for="extra_params">Extra request settings</label>
						<input
							id="extra_params"
							name="extraParams"
							type="text"
							class="input"
							spellcheck="false"
							autocomplete="off"
							value={paramsText(data.assistant.extraParams)}
							placeholder={'{"top_p": 0.9}'}
						/>
						<p class="field-hint">
							Anything else your endpoint expects, written as JSON and sent with every request. Use
							this for settings Codex has no box for, such as a switch your server needs to turn
							reasoning off, or sampler settings of your own. Check your server's documentation for
							what it accepts. Leave it empty if you are not sure.
						</p>
					</div>
				{/if}
				<div class="field">
					<label for="tool_profile">Tools offered</label>
					<select id="tool_profile" name="toolProfile" class="select">
						<option value="full" selected={data.assistant.toolProfile !== 'minimal'}
							>All tools</option
						>
						<option value="minimal" selected={data.assistant.toolProfile === 'minimal'}
							>Fewer tools</option
						>
					</select>
					<p class="field-hint">
						The assistant can look things up in your work and hand suggestions back. Pick Fewer
						tools if your model is small or runs on your own machine: it then only reads a scene,
						suggests an edit, and leaves a comment, which smaller models handle far more reliably.
					</p>
				</div>
				<div class="field">
					<label for="spend_cap">Spend cap per review (USD)</label>
					<input
						id="spend_cap"
						name="spendCapUsd"
						type="number"
						class="input"
						min="0"
						step="0.01"
						value={data.assistant.spendCapUsd ?? ''}
						placeholder="No cap"
					/>
					<p class="field-hint">
						A background review stops after the next scene once it has spent this much. Leave it
						empty for no cap. It only applies when your endpoint publishes prices for the model.
					</p>
				</div>
				<div class="field">
					<label for="spend_warn">Warn above (USD)</label>
					<input
						id="spend_warn"
						name="spendWarnUsd"
						type="number"
						class="input"
						min="0"
						step="0.01"
						value={data.assistant.spendWarnUsd ?? ''}
						placeholder="2.00"
					/>
					<p class="field-hint">
						Before a chapter or whole-story review starts, you are shown what it will send. Above
						this figure the window asks you to confirm again.
					</p>
				</div>
				<div class="settings-actions">
					{#if form?.scope === 'assistant-test' && 'reply' in form && form.reply}
						<FormStatus success={`Reply: ${form.reply}`} />
					{:else}
						<FormStatus
							error={(form?.scope === 'assistant-test' || form?.scope === 'assistant-endpoint') &&
							form.message
								? form.message
								: null}
							success={form?.scope === 'assistant-endpoint' && form.saved ? 'Saved.' : null}
						/>
					{/if}
					<button type="submit" class="btn btn-ghost" formaction="?/testAssistant"
						>Test connection</button
					>
				</div>
			</form>
		</div>
	</div>

	<div class="admin-block">
		<div class="settings-group">
			<header class="settings-group-header">
				<h2 class="settings-group-title">Models per role</h2>
				<p class="settings-group-subtitle">
					Different tasks benefit from different models. Individual stories can override these
					defaults.
				</p>
			</header>
			<form
				method="POST"
				action="?/saveAssistantModels"
				use:enhance={autosaveSubmit}
				onchange={autosubmitForm}
			>
				{#if discoveredModels.length > 20}
					<div class="field">
						<label for="model_filter">Filter models</label>
						<input
							id="model_filter"
							type="search"
							class="input"
							data-no-autosave
							bind:value={modelFilter}
							placeholder="Type part of a model name"
						/>
						<p class="field-hint">
							Narrows the lists below. Models you already picked always stay listed.
						</p>
					</div>
				{/if}
				<div class="role-table">
					{#each ROLE_META as role (role.id)}
						<div class="role-row">
							<div class="role-row-label">
								<div class="role-row-name">{role.name}</div>
								<div class="role-row-hint">{role.hint}</div>
								<div class="role-row-hint">{role.suggestion}</div>
							</div>
							<div class="role-row-controls">
								<select class="select" name={role.id}>
									<option value="" selected={!savedModels[role.id]}>Use endpoint default</option>
									{#each modelOptions as model (model)}
										<option value={model} selected={savedModels[role.id] === model}
											>{modelLabel(model)}</option
										>
									{/each}
								</select>
								<div class="role-row-tuning">
									<select
										class="select"
										name="{role.id}-thinking"
										aria-label="{role.name} thinking"
										value={thinkingValue(role.id)}
									>
										<option value="">Thinking: default</option>
										<option value="on">Thinking on</option>
										<option value="off">Thinking off</option>
									</select>
									{#if data.assistant.provider === 'anthropic'}
										<select class="select" name="{role.id}-effort" aria-label="{role.name} effort">
											<option value="" selected={!savedTuning[role.id]?.effort}
												>Default effort</option
											>
											{#each EFFORT_OPTIONS as level (level)}
												<option value={level} selected={savedTuning[role.id]?.effort === level}
													>Effort: {level}</option
												>
											{/each}
										</select>
									{:else}
										<input
											class="input"
											type="number"
											min="0"
											max="2"
											step="0.1"
											name="{role.id}-temperature"
											aria-label="{role.name} temperature"
											value={savedTuning[role.id]?.temperature ?? ''}
											placeholder="Temperature"
										/>
									{/if}
									<input
										class="input"
										type="number"
										min="1"
										step="1"
										name="{role.id}-maxTokens"
										aria-label="{role.name} longest reply in tokens"
										value={savedTuning[role.id]?.maxTokens ?? ''}
										placeholder="Longest reply"
									/>
									{#if extraParamsShown}
										<input
											class="input"
											type="text"
											spellcheck="false"
											autocomplete="off"
											name="{role.id}-extraParams"
											aria-label="{role.name} extra request settings"
											value={paramsText(savedTuning[role.id]?.extraParams)}
											placeholder="Extra settings"
										/>
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
				<p class="field-hint">
					Thinking lets the model reason before it answers: better feedback, slower and more tokens.
					Pick Thinking off for the roles that need to be quick, or leave it on default to use
					whatever your endpoint does already.
				</p>
				{#if data.assistant.provider === 'anthropic'}
					<p class="field-hint">
						Effort sets how hard the model works on each request; leave it unset for the model's
						default. Older or lighter models may not accept every level - if a request fails, clear
						the effort here. "xhigh" needs a recent Opus model.
					</p>
				{:else}
					<p class="field-hint">
						Temperature sets how freely the model varies its wording, from 0 to 2. Lower is more
						precise and repeatable, higher is more surprising; the reviewer works best low, around
						0.2. Leave a box empty to use your endpoint's own setting.
					</p>
				{/if}
				<p class="field-hint">
					Longest reply is the most a model may write in one go, counted in tokens. Raise it for a
					role that gets cut off mid-sentence, lower it to keep a model brief. Leave a box empty to
					use what Codex asks for.
				</p>
				{#if extraParamsShown}
					<p class="field-hint">
						Extra settings are JSON sent with this role's requests only, laid over the ones set on
						your endpoint above. Use it when one role needs something different, such as a switch
						that turns reasoning off for the reviewer.
					</p>
				{/if}
				{#if chosenModels.length > 0}
					<div class="role-table">
						{#each chosenModels as model (model)}
							<div class="role-row">
								<div class="role-row-label">
									<div class="role-row-name">{model}</div>
									<div class="role-row-hint">
										{#if discoveredContext[model]}
											Your endpoint reports {discoveredContext[model].toLocaleString()} tokens.
										{:else}
											Your endpoint does not report a context window.
										{/if}
									</div>
								</div>
								<div class="role-row-controls">
									<input
										class="input"
										type="number"
										min="1"
										step="1"
										name="context-{model}"
										aria-label="{model} context window in tokens"
										value={manualContext[model] ?? ''}
										placeholder={discoveredContext[model]
											? String(discoveredContext[model])
											: 'Context window in tokens'}
									/>
								</div>
							</div>
						{/each}
					</div>
					<p class="field-hint">
						The context window is how much text a model can take in one request, counted in tokens.
						Type a number to set it yourself; what you type is kept when you discover models again.
						Leave a box empty to use what your endpoint reports. If you run the model yourself,
						enter the size you started the server with, which is often smaller than the model can
						handle.
					</p>
				{/if}
				{#if Object.keys(modelPricing).length > 0}
					<p class="field-hint">
						Prices are what the endpoint reports, in dollars per million tokens: what you send (in)
						and what the model writes back (out).
					</p>
				{/if}
				<div class="settings-actions">
					{#if form?.scope === 'assistant-discover' && 'models' in form}
						<FormStatus
							success={`Found ${discoveredModels.length} model${pluralSuffix(discoveredModels.length)}.`}
						/>
					{:else}
						<FormStatus
							error={(form?.scope === 'assistant-discover' || form?.scope === 'assistant-models') &&
							form.message
								? form.message
								: null}
							success={form?.scope === 'assistant-models' && form.saved ? 'Saved.' : null}
						/>
					{/if}
					<button type="submit" class="btn btn-ghost" formaction="?/discoverAssistantModels"
						>Discover models</button
					>
				</div>
			</form>
		</div>
	</div>

	<div class="admin-block">
		<div class="settings-group">
			<header class="settings-group-header">
				<h2 class="settings-group-title">Usage</h2>
				<p class="settings-group-subtitle">
					Every request the assistant sends to your endpoint, with the token counts it reported.
					Costs are estimates, shown when your endpoint publishes prices.
				</p>
			</header>
			{#if data.assistantUsage.recent.length === 0 && data.assistantUsage.page === 0}
				<p class="field-hint">No requests yet.</p>
			{:else}
				{#if data.assistantUsage.totals.requests > 0}
					<p class="field-hint">
						Last 30 days: {data.assistantUsage.totals.requests} request{pluralSuffix(
							data.assistantUsage.totals.requests
						)}, {data.assistantUsage.totals.promptTokens.toLocaleString()} tokens sent,
						{data.assistantUsage.totals.completionTokens.toLocaleString()} received{#if usageTotalCost !== null},
							about ${usageTotalCost.toFixed(2)}{/if}.
					</p>
				{/if}
				<div>
					{#each data.assistantUsage.recent as entry (entry.id)}
						{@const cost = usageCost(entry.model, entry.promptTokens, entry.completionTokens)}
						<div class="list-row">
							<div class="list-main">
								<div class="list-title">{entry.model}</div>
								<div class="list-sub">
									{new Date(entry.createdAt).toLocaleString()} - {entry.role}
									{#if entry.promptTokens !== null || entry.completionTokens !== null}
										- {(entry.promptTokens ?? 0).toLocaleString()} in / {(
											entry.completionTokens ?? 0
										).toLocaleString()} out
									{:else}
										- token counts not reported
									{/if}
									{#if cost !== null}
										- about ${cost.toFixed(4)}
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
				{#if data.assistantUsage.page > 0 || data.assistantUsage.hasMore}
					<div class="settings-actions">
						<!-- eslint-disable svelte/no-navigation-without-resolve (usagePageHref resolves the section path) -->
						{#if data.assistantUsage.page > 0}
							<a class="btn btn-ghost" href={usagePageHref(data.assistantUsage.page - 1)}>Newer</a>
						{/if}
						{#if data.assistantUsage.hasMore}
							<a class="btn btn-ghost" href={usagePageHref(data.assistantUsage.page + 1)}>Older</a>
						{/if}
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
