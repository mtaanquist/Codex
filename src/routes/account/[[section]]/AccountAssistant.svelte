<script lang="ts">
	import { ROLE_META } from '#lib/assistant-roles';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import { withQuery } from '#lib/href';
	import { resolve } from '$app/paths';
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit, autosubmitForm } from '#lib/autosave-form';
	import { usageCostUsd } from '#lib/assistant-cost';
	import { askConfirm } from '#lib/confirm.svelte';
	import { formatDateTime, formatNumber, pluralSuffix, spentPhrase } from '#lib/format';
	import { resolveRoleModel, type AssistantRole } from '#lib/assistant-tuning';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import HelpLink from '#lib/components/HelpLink.svelte';
	import RoleTuningModal from '#lib/components/RoleTuningModal.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The Assistant's kill switch reads inverted: engaged (checked) means off.
	const assistantOff = $derived(!data.assistant.enabled);

	// The model dropdowns offer whatever the last discovery returned, unioned with
	// any model already chosen, so a saved pick always shows even before a refresh.
	// A filter box narrows large catalogues (OpenRouter lists hundreds); saved
	// picks always stay in the list so a save never silently drops one.
	type DiscoveredModel = {
		id: string;
		pricing?: { prompt: number; completion: number };
		contextLength?: number;
	};
	const savedModels = $derived(data.assistant.models);

	// Per-role tuning. Every control for it lives in the modal, which the row's
	// Tune button opens; the row carries a summary so the table still says what
	// each role is set to without opening anything.
	const savedTuning = $derived(data.assistant.tuning);
	// What the row shows next to its Tune button: only the settings this
	// provider reads, so it matches what the modal offers. Values stored for the
	// other provider stay untouched and unlisted.
	function tuningSummary(role: AssistantRole): string {
		const tuning = savedTuning[role];
		if (!tuning) return 'Defaults';
		const parts: string[] = [];
		if (tuning.thinking === true) parts.push('Thinking on');
		if (tuning.thinking === false) parts.push('Thinking off');
		if (anthropicShown) {
			if (tuning.effort) parts.push(`Effort ${tuning.effort}`);
		} else if (tuning.temperature !== undefined) {
			parts.push(`Temperature ${tuning.temperature}`);
		}
		if (tuning.maxTokens) parts.push(`${formatNumber(tuning.maxTokens)} tokens`);
		if (extraParamsShown && tuning.extraParams) parts.push('Extra settings');
		return parts.length > 0 ? parts.join(', ') : 'Defaults';
	}

	// The role whose tuning modal is open, and the button that opened it, so
	// focus goes back where it came from. Closing saves what the modal held
	// back, but only when something in it was actually touched: opening a role
	// to read what it is set to should not write the config.
	let tuningRole = $state<(typeof ROLE_META)[number] | null>(null);
	let tuningOpener: HTMLButtonElement | null = null;
	let modelsForm = $state<HTMLFormElement>();
	function openTuning(role: (typeof ROLE_META)[number], event: MouseEvent) {
		tuningOpener = event.currentTarget as HTMLButtonElement;
		tuningRole = role;
	}
	function closeTuning(changed: boolean) {
		// While the modal is open its fields are the only tuning on the form, so
		// this save touches that one role; the rest carry through untouched.
		if (changed) modelsForm?.requestSubmit();
		tuningRole = null;
		tuningOpener?.focus();
		tuningOpener = null;
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
		// A provider with verified ids offers them before any discovery.
		const suggested = Object.values(data.modelGuide.providers[selectedProvider])
			.map((tier) => tier.id)
			.filter((id): id is string => !!id && (!filter || id.toLowerCase().includes(filter)));
		return [
			...new Set([
				...ids,
				...suggested,
				...Object.values(savedModels).filter((m): m is string => !!m)
			])
		];
	});
	// Per-token prices: what the endpoint reported at the last discovery (or the
	// one just run), with anything typed here laid over it.
	type Price = { prompt: number; completion: number };
	const discoveredPricing = $derived({
		...(data.assistant.modelPricing ?? {}),
		...Object.fromEntries(discoveredModels.filter((m) => m.pricing).map((m) => [m.id, m.pricing!]))
	} as Record<string, Price>);
	const manualPricing = $derived(
		(data.assistant.modelPricingManual ?? {}) as Record<string, Price>
	);
	const modelPricing = $derived({ ...discoveredPricing, ...manualPricing });
	// A stored per-token price back as the dollars per million tokens that were
	// typed, without the rounding noise of the division.
	// The form saves on every change, and half a price cannot be stored, so a
	// pair with one box filled waits for the other before it saves. A change
	// elsewhere on the form still saves, and the reply names the unfinished pair.
	function holdHalfPrice(event: Event & { currentTarget: HTMLElement }) {
		const filled = [...event.currentTarget.querySelectorAll('input')].filter(
			(box) => box.value.trim() !== ''
		);
		if (filled.length === 1) event.stopPropagation();
	}
	function perMillionValue(perToken: number | undefined): string {
		return perToken === undefined ? '' : String(Number((perToken * 1_000_000).toPrecision(12)));
	}
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
	// The models with a context field and price boxes: every model a role runs
	// on right now, picked or not, and every model chosen on a universe or a
	// story. With Claude a role nobody picked a model for runs on its suggested
	// one, and that one needs a price like any other.
	const chosenModels = $derived([
		...new Set([
			...ROLE_META.map((role) => runningModel(role.id)).filter(Boolean),
			...data.scopeModels
		])
	]);
	function modelLabel(id: string): string {
		const price = modelPricing[id];
		const tokens = contextWindow(id);
		const parts = [
			price
				? `${perMillion(price.prompt)} in / ${perMillion(price.completion)} out per 1M tokens`
				: '',
			tokens ? `${formatNumber(tokens)} token context` : ''
		].filter(Boolean);
		return parts.length > 0 ? `${id} (${parts.join(', ')})` : id;
	}
	// A row's cost at the same cache rates the spend cap uses. A row with no
	// cache shares is priced at the plain price.
	function usageCost(row: {
		model: string;
		promptTokens: number | null;
		completionTokens: number | null;
		cachedPromptTokens: number | null;
		cacheWriteTokens: number | null;
		cacheWrite1hTokens: number | null;
	}) {
		const price = modelPricing[row.model];
		if (!price || (row.promptTokens === null && row.completionTokens === null)) return null;
		return usageCostUsd(price, {
			...row,
			promptTokens: row.promptTokens ?? 0,
			completionTokens: row.completionTokens ?? 0
		});
	}
	const usageTotalCost = $derived.by(() => {
		let total = 0;
		let known = false;
		for (const row of data.assistantUsage.byModel) {
			const cost = usageCost(row);
			if (cost !== null) {
				total += cost;
				known = true;
			}
		}
		return known ? total : null;
	});

	// The usage log pages through ?usage=N on the assistant section.
	function usagePageHref(n: number): ResolvedPathname {
		const base = resolve('/account/[[section]]', { section: 'assistant' });
		return n > 0 ? withQuery(base, { usage: n }) : base;
	}

	// The provider picker: a preset prefills and locks the endpoint URL (the
	// server stores the preset's URL regardless); custom keeps the free field.
	// The initial value is intentionally a snapshot; the select owns it after.
	// svelte-ignore state_referenced_locally
	let selectedProvider = $state(data.assistant.provider);
	const activePreset = $derived(data.providers.find((p) => p.id === selectedProvider));
	// Which provider the form is showing, from the live select rather than the
	// saved value, so every provider-specific control appears and disappears
	// together while a change is still saving.
	const anthropicShown = $derived(selectedProvider === 'anthropic');
	// Extra request settings only reach an OpenAI-compatible endpoint; the Claude
	// provider has its own controls and ignores them, so the boxes stay hidden.
	const extraParamsShown = $derived(!anthropicShown);
	// A switch clears the saved key and the model picks on the server, so it
	// asks first when there is something to lose. The key box is emptied before
	// the form saves: a key typed for the old provider must not be saved as the
	// new one's.
	let apiKeyField = $state<HTMLInputElement>();
	async function switchProvider(event: Event & { currentTarget: HTMLSelectElement }) {
		const select = event.currentTarget;
		if (select.value === data.assistant.provider) return;
		const hasPicks = Object.values(savedModels).some(Boolean);
		const ask = data.assistant.hasKey || hasPicks || Object.keys(manualPricing).length > 0;
		// Hold the form's autosave until the answer; a yes saves it below.
		if (ask) event.stopPropagation();
		const go =
			!ask ||
			(await askConfirm({
				title: 'Switch provider?',
				body: 'Your saved API key, the models picked for each role, and any prices you typed are cleared.',
				confirmLabel: 'Switch provider'
			}));
		if (!go) {
			selectedProvider = data.assistant.provider;
			return;
		}
		if (apiKeyField) apiKeyField.value = '';
		discoveredModels = [];
		if (ask) {
			select.form?.requestSubmit();
			return;
		}
		// The old preset's URL is still in the box; a custom endpoint starts
		// empty. After a prompt the box has already re-rendered for the new
		// provider, so clearing it then would wipe the new preset's URL.
		const endpointField = select.form?.elements.namedItem('endpoint');
		if (endpointField instanceof HTMLInputElement) endpointField.value = '';
	}
	// Once a key is saved the box empties, so it is never resent with a later
	// switch; the placeholder then says a key is saved.
	$effect(() => {
		if (
			(form?.scope === 'assistant-endpoint' && 'saved' in form && form.saved) ||
			form?.scope === 'assistant-test'
		) {
			if (apiKeyField) apiKeyField.value = '';
		}
		// A refused save leaves the stored provider in place; show it again.
		if (form?.scope === 'assistant-endpoint' && form.message) {
			selectedProvider = data.assistant.provider;
		}
	});
	// The guide follows the live select, like the provider-specific controls.
	function suggestion(role: AssistantRole) {
		return data.modelGuide.providers[selectedProvider][data.modelGuide.tiers[role]];
	}
	function suggestionLine(role: AssistantRole): string {
		const { id, text } = suggestion(role);
		return id ? `${text} (${id})` : text;
	}
	// What a role runs on with nothing picked. This follows the saved provider,
	// not the live select, since that is what the server runs until a switch
	// lands.
	function suggestedModel(role: AssistantRole): string {
		const saved = data.modelGuide.providers[data.assistant.provider];
		return saved[data.modelGuide.tiers[role]].id ?? '';
	}
	// The model a role runs on, picked or not.
	function runningModel(role: AssistantRole): string {
		return resolveRoleModel(savedModels, role, suggestedModel(role));
	}
	function unpickedLabel(role: AssistantRole): string {
		const suggested = suggestedModel(role);
		const runs = runningModel(role);
		if (!runs) return 'Pick a model';
		if (runs === suggested) return `Suggested: ${runs}`;
		if (runs === savedModels.chat) return 'Same as Rubber duck';
		return `Same as ${runs}`;
	}
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
					<div class="ks-sub" role="alert" style="color:var(--danger-ink);">
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

<div class="admin-block" id="assistant-how">
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
	<div class="admin-block" id="assistant-identity">
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

	<div class="admin-block" id="assistant-endpoint">
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
						onchange={switchProvider}
					>
						{#each data.providers as preset (preset.id)}
							<option value={preset.id}>{preset.label}</option>
						{/each}
						<option value="custom">Custom endpoint</option>
					</select>
					{#if activePreset}
						<p class="field-hint">
							<a href={activePreset.docsUrl} target="_blank" rel="external noopener noreferrer"
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
						bind:this={apiKeyField}
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
				{#if anthropicShown}
					<div class="field">
						<!-- An unchecked box sends nothing, which is indistinguishable from a
						     save that never showed it; this marker says the box was on the form. -->
						<input type="hidden" name="webSearchShown" value="1" />
						<label class="check-row">
							<input type="checkbox" name="webSearch" checked={data.assistant.webSearch} />
							Let the assistant search the web
						</label>
						<p class="field-hint">
							Claude can look things up while it works, on Anthropic's servers rather than yours. It
							only does so in a universe you have marked as an established setting, where it may
							need to check your draft against a published world's canon. Searches are part of what
							Anthropic bills you for.
						</p>
					</div>
					<div class="field">
						<label for="cache_ttl">Keep repeated text ready for</label>
						<select id="cache_ttl" name="cacheTtl" class="select">
							<option value="5m" selected={data.assistant.cacheTtl !== '1h'}>5 minutes</option>
							<option value="1h" selected={data.assistant.cacheTtl === '1h'}>1 hour</option>
						</select>
						<p class="field-hint">
							Claude charges much less for text it was sent a short while ago, such as your story
							notes going out again with each message. Choose 1 hour if you often pause for more
							than 5 minutes between messages. With 1 hour, new text costs about twice the normal
							price the first time it is sent.
						</p>
					</div>
				{/if}
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
					<label for="tool_call_limit">Lookups per reply</label>
					<input
						id="tool_call_limit"
						name="toolCallLimit"
						type="number"
						class="input"
						min="1"
						max={data.toolCallLimitMax}
						step="1"
						value={data.assistant.toolCallBudget}
					/>
					<input type="hidden" name="toolCallLimitShown" value={data.assistant.toolCallBudget} />
					<p class="field-hint">
						How many times the Assistant may look something up (read a scene, check a character,
						search your work) before it has to answer. This also applies to reviews. A question
						about a whole chapter needs one lookup per scene. Raise it if replies say they ran out
						of lookups; lower it if your endpoint charges per request. With Fewer tools, the
						Assistant gets half this number.
					</p>
				</div>
				<div class="field">
					<label for="spend_cap">Spend cap per background run (USD)</label>
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
						A background run stops once it has spent about this much. Leave it empty for no cap.
						<a href={resolve('/docs/[topic]', { topic: 'account' })}>How the cap works</a>
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

	<div class="admin-block" id="assistant-models">
		<div class="settings-group">
			<header class="settings-group-header">
				<h2 class="settings-group-title">Models per role</h2>
				<p class="settings-group-subtitle">
					Different tasks benefit from different models. A universe or a story can choose its own in
					its settings.
				</p>
			</header>
			<form
				method="POST"
				action="?/saveAssistantModels"
				bind:this={modelsForm}
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
								<div class="role-row-hint">Suggested: {suggestionLine(role.id)}.</div>
							</div>
							<div class="role-row-controls">
								<select class="select" name={role.id}>
									<option value="" selected={!savedModels[role.id]}>{unpickedLabel(role.id)}</option
									>
									{#each modelOptions as model (model)}
										<option value={model} selected={savedModels[role.id] === model}
											>{modelLabel(model)}</option
										>
									{/each}
								</select>
								<div class="role-row-tune">
									<span class="role-row-summary" title={tuningSummary(role.id)}
										>{tuningSummary(role.id)}</span
									>
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										aria-label="Tune {role.name}"
										onclick={(event) => openTuning(role, event)}>Tune</button
									>
								</div>
							</div>
						</div>
					{/each}
				</div>
				<p class="field-hint">
					Pick a model for each role; the suggestion under each name is a good place to start for
					the provider you picked. Tune opens that role's thinking, temperature, and reply length.
				</p>
				{#if tuningRole}
					<!-- Rendered inside the form so its fields save with the table. Only the
					     open role's fields are on the form, so the others keep what is stored. -->
					{#key tuningRole.id}
						<RoleTuningModal
							role={tuningRole}
							suggestion={suggestionLine(tuningRole.id)}
							saved={savedTuning[tuningRole.id] ?? {}}
							anthropic={anthropicShown}
							model={runningModel(tuningRole.id)}
							contextWindow={savedModels[tuningRole.id]
								? contextWindow(savedModels[tuningRole.id]!)
								: undefined}
							onClose={closeTuning}
						/>
					{/key}
				{/if}
				{#if chosenModels.length > 0}
					<div class="role-table">
						{#each chosenModels as model (model)}
							<div class="role-row">
								<div class="role-row-label">
									<div class="role-row-name">{model}</div>
									<div class="role-row-hint">
										{#if discoveredContext[model]}
											Your endpoint reports {formatNumber(discoveredContext[model])} tokens.
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
									<div class="price-pair" onchange={holdHalfPrice}>
										<input
											class="input"
											type="number"
											min="0"
											step="any"
											name="price-in-{model}"
											aria-label="{model} price per million tokens sent, in dollars"
											value={perMillionValue(manualPricing[model]?.prompt)}
											placeholder={discoveredPricing[model]
												? perMillionValue(discoveredPricing[model].prompt)
												: 'Price in'}
										/>
										<input
											class="input"
											type="number"
											min="0"
											step="any"
											name="price-out-{model}"
											aria-label="{model} price per million tokens received, in dollars"
											value={perMillionValue(manualPricing[model]?.completion)}
											placeholder={discoveredPricing[model]
												? perMillionValue(discoveredPricing[model].completion)
												: 'Price out'}
										/>
									</div>
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
					<p class="field-hint">
						Prices are in dollars per million tokens: what you send (in) and what the model writes
						back (out). If your endpoint does not report prices, look them up on your provider's
						pricing page and type both in. Cost estimates and the spend cap need them. What you type
						is kept when you discover models again; leave both boxes empty to use what your endpoint
						reports. If you switch provider or move a custom endpoint to another server, the prices
						you typed are cleared, so enter them again.
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

	<div class="admin-block" id="assistant-usage">
		<div class="settings-group">
			<header class="settings-group-header">
				<h2 class="settings-group-title">
					Usage <HelpLink topic="account" label="usage and cost" />
				</h2>
				<p class="settings-group-subtitle">
					Every request the assistant sends to your endpoint, with the token counts it reported.
					Costs are estimates, shown for models that have a price.
				</p>
			</header>
			{#if data.assistantUsage.recent.length === 0 && data.assistantUsage.page === 0}
				<p class="field-hint">No requests yet.</p>
			{:else}
				{#if data.assistantUsage.totals.requests > 0}
					<p class="field-hint">
						Last 30 days: {data.assistantUsage.totals.requests} request{pluralSuffix(
							data.assistantUsage.totals.requests
						)}, {formatNumber(data.assistantUsage.totals.promptTokens)} tokens sent,
						{formatNumber(data.assistantUsage.totals.completionTokens)} received{#if data.assistantUsage.totals.webSearchRequests > 0},
							{data.assistantUsage.totals.webSearchRequests} web search{data.assistantUsage.totals
								.webSearchRequests === 1
								? ''
								: 'es'}{/if}{#if usageTotalCost !== null},
							{spentPhrase(usageTotalCost)}{/if}.
						{#if data.assistantUsage.totals.estimatedRequests > 0}
							Includes {data.assistantUsage.totals.estimatedRequests} estimated request{pluralSuffix(
								data.assistantUsage.totals.estimatedRequests
							)}.
						{/if}
					</p>
				{/if}
				<div>
					{#each data.assistantUsage.recent as entry (entry.id)}
						{@const cost = usageCost(entry)}
						<div class="list-row">
							<div class="list-main">
								<div class="list-title">{entry.model}</div>
								<div class="list-sub">
									{formatDateTime(entry.createdAt, page.data.timeZone)} - {entry.role}
									{#if entry.promptTokens !== null || entry.completionTokens !== null}
										- {formatNumber(entry.promptTokens ?? 0)} in / {formatNumber(
											entry.completionTokens ?? 0
										)} out{#if entry.estimated}, estimated{/if}
									{:else}
										- token counts not reported
									{/if}
									{#if entry.webSearchRequests}
										- {entry.webSearchRequests} web search{entry.webSearchRequests === 1
											? ''
											: 'es'}
									{/if}
									{#if cost !== null}
										- {spentPhrase(cost, false, 4)}
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
				{#if data.assistantUsage.page > 0 || data.assistantUsage.hasMore}
					<div class="settings-actions">
						{#if data.assistantUsage.page > 0}
							<a class="btn btn-ghost" href={usagePageHref(data.assistantUsage.page - 1)}>Newer</a>
						{/if}
						{#if data.assistantUsage.hasMore}
							<a class="btn btn-ghost" href={usagePageHref(data.assistantUsage.page + 1)}>Older</a>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
