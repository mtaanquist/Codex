<script lang="ts">
	// The right pane's Assistant tab: a chat with the writing Assistant,
	// grounded in the open story. The conversation is kept per story and user:
	// the server stores each completed turn and the page load seeds the panel,
	// so it survives a reload. The server holds the key and endpoint; this only
	// POSTs the transcript and streams tokens back over Server-Sent Events.
	import { enhance } from '$app/forms';
	import { assistantIntent } from '$lib/assistant.svelte';
	import { startSummariesJob } from '$lib/assistant-actions';
	import Icon from './Icon.svelte';

	let {
		storyId,
		sceneId = null,
		name,
		storyTitle,
		muted,
		suggestions = [],
		initialMessages = [],
		onConfirmSplit,
		onInsert
	}: {
		storyId: string;
		// The open scene, sent as the focus of context assembly; null off a scene.
		sceneId?: string | null;
		// The Assistant's display name, shown over its replies.
		name: string;
		storyTitle: string;
		// This story has muted the Assistant; the tab stays to un-mute.
		muted: boolean;
		// Grounded starter prompts shown when the conversation is empty.
		suggestions?: string[];
		// The stored conversation, loaded with the page; the panel seeds from it
		// at mount and the client transcript carries on from there.
		initialMessages?: {
			role: 'user' | 'assistant';
			content: string;
			meta: {
				reference?: { sceneId: string; text: string };
				proposals?: Omit<SplitProposal, 'confirming' | 'error'>[];
			} | null;
		}[];
		// Confirms a proposed scene split; resolves to an error message, or null
		// when the split landed (the page navigates to the new scene).
		onConfirmSplit?: (proposal: { sceneId: string; before: string }) => Promise<string | null>;
		// Inserts a reply's text into the open scene editor at the cursor; only
		// passed when a single scene editor is open.
		onInsert?: (text: string) => void;
	} = $props();

	type ChatReference = { sceneId: string; text: string };
	// A scene split the Assistant proposed; rendered as a card with a confirm
	// button, plus client-side confirm state.
	type SplitProposal = {
		sceneId: string;
		sceneTitle: string | null;
		before: string;
		rationale: string;
		confirming?: boolean;
		error?: string;
	};
	type Message = {
		role: 'user' | 'assistant';
		content: string;
		reference?: ChatReference;
		proposals?: SplitProposal[];
	};
	type StreamEvent =
		| { type: 'token'; text: string }
		| { type: 'proposal'; proposal: SplitProposal }
		| { type: 'done' }
		| { type: 'error'; message: string };

	// Seeded once at mount from the stored conversation, falling back to a
	// synthesized opening line (which is never stored); the transcript is then
	// client-held until the next mount picks up the persisted turns.
	// svelte-ignore state_referenced_locally
	const opening = `I've read your codex for ${storyTitle}. Ask me about your characters, check continuity, or work a scene.`;
	// svelte-ignore state_referenced_locally
	const seeded: Message[] = initialMessages.map((m) => ({
		role: m.role,
		content: m.content,
		reference: m.meta?.reference,
		proposals: m.meta?.proposals?.map((p) => ({ ...p }))
	}));
	let messages = $state<Message[]>(
		seeded.length > 0 ? seeded : [{ role: 'assistant', content: opening }]
	);
	let input = $state('');
	let busy = $state(false);
	let composer = $state<HTMLTextAreaElement>();
	let scroll = $state<HTMLDivElement>();
	let pending: AbortController | null = null;

	$effect(() => {
		// Re-read on every transcript change so the newest turn stays in view.
		void messages.length;
		void busy;
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
	});

	function appendToReply(text: string) {
		const last = messages[messages.length - 1];
		if (last && last.role === 'assistant') {
			last.content += text;
		}
	}

	// A proposal frame attaches to the reply being streamed, rendering as a
	// card with a confirm button under the bubble.
	function attachProposal(proposal: SplitProposal) {
		const last = messages[messages.length - 1];
		if (last && last.role === 'assistant') {
			last.proposals = [...(last.proposals ?? []), proposal];
		}
	}

	async function confirmSplit(proposal: SplitProposal) {
		if (!onConfirmSplit || proposal.confirming) return;
		proposal.confirming = true;
		proposal.error = '';
		try {
			const failure = await onConfirmSplit({
				sceneId: proposal.sceneId,
				before: proposal.before
			});
			if (failure) proposal.error = failure;
		} catch {
			proposal.error = 'Could not split the scene. Try again.';
		} finally {
			proposal.confirming = false;
		}
	}

	// Stream a reply into the empty assistant message the caller has already
	// pushed. Shared by chat (send) and recap (catchUp): both POST JSON and read
	// the same token/done/error Server-Sent Event frames.
	async function streamInto(url: string, payload: unknown) {
		busy = true;
		const controller = new AbortController();
		pending = controller;
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				signal: controller.signal
			});
			if (!response.ok || !response.body) {
				appendToReply(
					'Sorry, I could not reach the Assistant. Check the endpoint in your account settings.'
				);
				return;
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let streamError = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';
				for (const frame of frames) {
					const line = frame.trim();
					if (!line.startsWith('data:')) continue;
					const json = line.slice(5).trim();
					if (!json) continue;
					const event = JSON.parse(json) as StreamEvent;
					if (event.type === 'token') appendToReply(event.text);
					else if (event.type === 'proposal') attachProposal(event.proposal);
					else if (event.type === 'error') streamError = event.message;
				}
			}
			const reply = messages[messages.length - 1];
			if (reply && reply.role === 'assistant' && reply.content === '') {
				reply.content = streamError || 'The Assistant did not return a response.';
			}
		} catch {
			if (!controller.signal.aborted) {
				appendToReply('Sorry, something went wrong reaching the Assistant.');
			}
		} finally {
			busy = false;
			pending = null;
		}
	}

	// A passage the next message points at, set from "Ask the Assistant about
	// this" on a selection; shown as a chip the writer can remove before sending.
	let reference = $state<ChatReference | null>(null);

	async function send(text?: string) {
		const question = (text ?? input).trim();
		if (!question || busy) return;
		input = '';
		if (composer) composer.style.height = 'auto';
		const turn: Message = { role: 'user', content: question };
		if (reference) {
			turn.reference = reference;
			reference = null;
		}
		// The turn the model answers, then an empty reply to stream into. The
		// request carries a window of recent turns; older context lives in the
		// assembled world, not the transcript.
		const turns: Message[] = [...messages, turn];
		messages = [...turns, { role: 'assistant', content: '' }];
		await streamInto('/api/assistant/chat', {
			storyId,
			sceneId,
			messages: turns
				.slice(-40)
				.map((m) => ({ role: m.role, content: m.content, reference: m.reference }))
		});
	}

	// Intents raised by the editor menus or the command palette: the page has
	// already switched the right pane here; the panel acts on the intent.
	$effect(() => {
		const intent = assistantIntent.pending;
		if (!intent || muted) return;
		assistantIntent.pending = null;
		if (intent.kind === 'reference') {
			reference = { sceneId: intent.sceneId, text: intent.text };
			composer?.focus();
		} else if (intent.kind === 'send') {
			void send(intent.text);
		} else if (intent.kind === 'catchup') {
			void catchUp();
		} else if (intent.kind === 'focus') {
			composer?.focus();
		}
	});

	// Catch me up: a recap of the story so far, streamed in as an assistant turn
	// with no question of its own.
	async function catchUp() {
		if (busy) return;
		messages = [...messages, { role: 'assistant', content: '' }];
		await streamInto('/api/assistant/recap', { storyId, sceneId });
	}

	// Update summaries: a background pass that drafts and refreshes scene and
	// chapter summaries. It runs unattended, so this only kicks it off and
	// confirms; the writer is notified when it finishes.
	let summarising = $state(false);
	async function updateSummaries() {
		if (summarising) return;
		summarising = true;
		try {
			await startSummariesJob(storyId);
		} finally {
			summarising = false;
		}
	}

	function stop() {
		pending?.abort();
	}

	// Clear conversation: drops the stored transcript and starts fresh.
	let clearing = $state(false);
	async function clearConversation() {
		if (clearing || busy) return;
		if (!confirm('Clear this conversation? It cannot be brought back.')) return;
		clearing = true;
		try {
			const response = await fetch('/api/assistant/chat', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ storyId })
			});
			if (!response.ok) {
				alert('Could not clear the conversation.');
				return;
			}
			messages = [{ role: 'assistant', content: opening }];
			reference = null;
		} finally {
			clearing = false;
		}
	}

	// The actions menu next to the send button; closes like the other inline
	// menus, on an outside press or Escape.
	let actionsOpen = $state(false);

	function runAction(action: () => void) {
		actionsOpen = false;
		action();
	}

	function onWindowPointerDown(event: MouseEvent) {
		if (!actionsOpen) return;
		const target = event.target as HTMLElement | null;
		if (!target?.closest('.composer-menu-wrap')) actionsOpen = false;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && actionsOpen) {
			event.preventDefault();
			actionsOpen = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}

	function grow(event: Event) {
		const el = event.target as HTMLTextAreaElement;
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 120) + 'px';
		input = el.value;
	}

	// Crude **bold** rendering, matching the prototype: split into bold and plain
	// spans so the bubble shows emphasis without a full markdown pass.
	function segments(text: string): { bold: boolean; text: string }[] {
		return text
			.split(/(\*\*[^*]+\*\*)/g)
			.map((part) =>
				part.startsWith('**') && part.endsWith('**')
					? { bold: true, text: part.slice(2, -2) }
					: { bold: false, text: part }
			);
	}

	function paragraphs(text: string): string[] {
		return text.split(/\n{2,}/);
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

{#if muted}
	<div class="assistant-muted">
		<p>The Assistant is off for this story.</p>
		<p class="muted-hint">
			Turn it back on to chat about this book, review scenes, and write alongside it.
		</p>
		<form method="POST" action="?/unmuteAssistant" use:enhance>
			<button class="btn btn-primary" type="submit">Turn on for this story</button>
		</form>
	</div>
{:else}
	<div class="assistant">
		<div class="assistant-head">
			<span class="assistant-name"><Icon name="sparkles" size={13} /> {name}</span>
			<div class="head-actions">
				<form method="POST" action="?/muteAssistant" use:enhance>
					<button class="mute-link" type="submit" title="Hide the Assistant for this story">
						Mute for this story
					</button>
				</form>
			</div>
		</div>
		<div class="chat-scroll" bind:this={scroll} aria-live="polite" aria-atomic="false">
			{#each messages as message, index (index)}
				{#if message.role === 'user'}
					<div class="msg user">
						{#if message.reference}
							<div class="msg-ref">{message.reference.text}</div>
						{/if}{message.content}
					</div>
				{:else}
					<div class="msg assistant-msg">
						<div class="who"><Icon name="sparkles" size={12} /> {name}</div>
						<div class="bubble">
							{#if message.content === '' && busy && index === messages.length - 1}
								<div class="typing"><i></i><i></i><i></i></div>
							{:else}
								{#each paragraphs(message.content) as para, pi (pi)}
									<p>
										{#each segments(para) as seg, si (si)}
											{#if seg.bold}<strong>{seg.text}</strong>{:else}{seg.text}{/if}
										{/each}
									</p>
								{/each}
							{/if}
						</div>
						{#if onInsert && message.content && !(busy && index === messages.length - 1) && index > 0}
							<button
								class="msg-insert"
								type="button"
								title="Insert this reply into the scene at the cursor"
								onclick={() => onInsert(message.content)}
							>
								<Icon name="plus" size={12} /> Insert at cursor
							</button>
						{/if}
						{#each message.proposals ?? [] as proposal, pi (pi)}
							<div class="proposal">
								<div class="proposal-head">
									<Icon name="split" size={13} />
									Split {proposal.sceneTitle ? `"${proposal.sceneTitle}"` : 'this scene'}
								</div>
								{#if proposal.rationale}
									<p class="proposal-why">{proposal.rationale}</p>
								{/if}
								<div class="proposal-quote">{proposal.before}</div>
								<div class="proposal-actions">
									{#if onConfirmSplit}
										<button
											class="btn btn-primary"
											type="button"
											disabled={proposal.confirming}
											onclick={() => confirmSplit(proposal)}
										>
											{proposal.confirming ? 'Splitting...' : 'Split here'}
										</button>
									{/if}
									<span class="proposal-hint">The new scene starts at the quoted text.</span>
								</div>
								{#if proposal.error}
									<p class="proposal-error" role="alert">{proposal.error}</p>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/each}
		</div>

		{#if messages.length <= 1 && !busy && suggestions.length > 0}
			<div class="suggest">
				{#each suggestions as suggestion (suggestion)}
					<button class="suggest-chip" type="button" onclick={() => send(suggestion)}>
						{suggestion}
					</button>
				{/each}
			</div>
		{/if}

		{#if reference}
			<div class="ref-chip" role="note">
				<span class="ref-quote" title={reference.text}>{reference.text}</span>
				<button
					class="ref-x"
					type="button"
					title="Remove the reference"
					aria-label="Remove the reference"
					onclick={() => (reference = null)}
				>
					x
				</button>
			</div>
		{/if}
		<div class="composer">
			<textarea
				bind:this={composer}
				rows="1"
				placeholder="Ask about your story..."
				value={input}
				oninput={grow}
				onkeydown={onKeydown}
			></textarea>
			<div class="composer-menu-wrap">
				<button
					class="menu-btn"
					type="button"
					title="More actions"
					aria-haspopup="menu"
					aria-expanded={actionsOpen}
					onclick={() => (actionsOpen = !actionsOpen)}
				>
					<Icon name="more" size={16} />
				</button>
				{#if actionsOpen}
					<div class="composer-menu" role="menu">
						<button
							class="composer-menu-item"
							type="button"
							role="menuitem"
							disabled={busy}
							title="Recap the story up to where you are"
							onclick={() => runAction(() => void catchUp())}
						>
							Catch me up
						</button>
						<button
							class="composer-menu-item"
							type="button"
							role="menuitem"
							disabled={summarising}
							title="Draft and refresh scene and chapter summaries in the background"
							onclick={() => runAction(() => void updateSummaries())}
						>
							{summarising ? 'Starting...' : 'Update summaries'}
						</button>
						<button
							class="composer-menu-item"
							type="button"
							role="menuitem"
							disabled={clearing || busy}
							title="Delete this conversation and start fresh"
							onclick={() => runAction(() => void clearConversation())}
						>
							Clear conversation
						</button>
					</div>
				{/if}
			</div>
			{#if busy}
				<button class="send-btn" type="button" title="Stop generating" onclick={stop}>
					<span class="stop-glyph"></span>
				</button>
			{:else}
				<button
					class="send-btn"
					type="button"
					disabled={!input.trim()}
					title="Send"
					onclick={() => send()}
				>
					<Icon name="send" size={16} />
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Ported from the app-design prototype's Assistant panel (right.jsx + theme.css). */
	.assistant {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.assistant-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}
	.assistant-name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: 6px 12px;
	}
	.mute-link {
		border: 0;
		background: none;
		padding: 0;
		font-size: 12px;
		color: var(--text-faint);
		cursor: pointer;
	}
	.mute-link:hover {
		color: var(--text);
		text-decoration: underline;
	}
	.chat-scroll {
		flex: 1;
		overflow: auto;
		padding: 16px 14px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-height: 0;
	}
	.msg {
		font-size: 14px;
		line-height: 1.55;
		max-width: 100%;
	}
	.msg.user {
		align-self: flex-end;
		background: var(--accent);
		color: var(--accent-contrast);
		padding: 9px 13px;
		border-radius: 13px 13px 4px 13px;
		max-width: 85%;
		white-space: pre-wrap;
	}
	.msg.assistant-msg {
		align-self: flex-start;
		color: var(--text);
		max-width: 100%;
	}
	.msg.assistant-msg .who {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin-bottom: 6px;
	}
	.msg.assistant-msg .bubble {
		background: var(--bg-card);
		border: 1px solid var(--border);
		padding: 11px 13px;
		border-radius: 4px 13px 13px 13px;
	}
	.msg.assistant-msg .bubble p {
		margin: 0 0 0.7em;
	}
	.msg.assistant-msg .bubble p:last-child {
		margin: 0;
	}
	.typing {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		padding: 4px 0;
	}
	.typing i {
		width: 6px;
		height: 6px;
		border-radius: 99px;
		background: var(--text-faint);
		animation: blink 1.2s infinite;
	}
	.typing i:nth-child(2) {
		animation-delay: 0.2s;
	}
	.typing i:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.25;
		}
		40% {
			opacity: 1;
		}
	}
	.suggest {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 0 14px 6px;
	}
	.suggest-chip {
		text-align: left;
		border: 1px solid var(--border);
		background: var(--bg-card);
		border-radius: 10px;
		padding: 9px 12px;
		font-size: 13px;
		color: var(--text-muted);
		cursor: pointer;
	}
	.suggest-chip:hover {
		color: var(--text);
		border-color: var(--border-strong);
		background: var(--bg-hover);
	}
	.composer {
		border-top: 1px solid var(--border);
		padding: 12px;
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}
	.composer textarea {
		flex: 1;
		resize: none;
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 9px 11px;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13.5px;
		line-height: 1.45;
		max-height: 120px;
		outline: none;
	}
	.composer textarea:focus {
		border-color: var(--accent-line);
	}
	.msg-insert {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-top: 6px;
		border: 0;
		background: none;
		padding: 0;
		font-size: 12px;
		color: var(--text-faint);
		cursor: pointer;
	}
	.msg-insert:hover {
		color: var(--accent);
		text-decoration: underline;
	}
	.proposal {
		margin-top: 8px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-card);
		padding: 10px 12px;
		font-size: 13px;
	}
	.proposal-head {
		display: flex;
		align-items: center;
		gap: 7px;
		font-weight: 600;
		color: var(--text);
	}
	.proposal-why {
		margin: 6px 0 0;
		color: var(--text-muted);
	}
	.proposal-quote {
		margin-top: 8px;
		border-left: 3px solid var(--accent);
		padding-left: 8px;
		color: var(--text-muted);
		font-size: 12.5px;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.proposal-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}
	.proposal-hint {
		font-size: 12px;
		color: var(--text-faint);
	}
	.proposal-error {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--danger, #c0392b);
	}
	.msg-ref {
		border-left: 2px solid var(--accent-contrast);
		opacity: 0.85;
		padding-left: 8px;
		margin-bottom: 6px;
		font-size: 12.5px;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.ref-chip {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 0 12px;
		padding: 7px 10px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: 8px;
		background: var(--bg-card);
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.ref-quote {
		flex: 1;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.ref-x {
		border: 0;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		font-size: 13px;
		line-height: 1;
		padding: 0 2px;
	}
	.ref-x:hover {
		color: var(--text);
	}
	.composer-menu-wrap {
		position: relative;
		flex: none;
	}
	.menu-btn {
		width: 36px;
		height: 36px;
		border-radius: 9px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-muted);
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.menu-btn:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}
	.composer-menu {
		position: absolute;
		bottom: 42px;
		right: 0;
		z-index: 60;
		min-width: 190px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius, 9px);
		box-shadow: var(--shadow);
		padding: 6px;
	}
	.composer-menu-item {
		display: block;
		width: 100%;
		text-align: left;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		padding: 6px 7px;
		border-radius: 5px;
		cursor: default;
	}
	.composer-menu-item:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	.composer-menu-item:disabled {
		color: var(--text-faint);
	}
	.send-btn {
		flex: none;
		width: 36px;
		height: 36px;
		border-radius: 9px;
		border: 0;
		background: var(--accent);
		color: var(--accent-contrast);
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.send-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.stop-glyph {
		width: 11px;
		height: 11px;
		border-radius: 2px;
		background: var(--accent-contrast);
	}
	.assistant-muted {
		padding: 28px 22px;
		text-align: center;
		color: var(--text-muted);
		font-size: 14px;
	}
	.assistant-muted .muted-hint {
		font-size: 12.5px;
		color: var(--text-faint);
		margin: 6px 0 16px;
	}
</style>
