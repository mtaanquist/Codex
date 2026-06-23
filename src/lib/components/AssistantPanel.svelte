<script lang="ts">
	// The right pane's Assistant tab: a chat with the writing Assistant,
	// grounded in the open story. The conversation is kept per story and user:
	// the server stores each completed turn and the page load seeds the panel,
	// so it survives a reload. The server holds the key and endpoint; this only
	// POSTs the transcript and streams tokens back over Server-Sent Events.
	import { enhance } from '$app/forms';
	import { assistantIntent } from '$lib/assistant.svelte';
	import {
		startSummariesJob,
		reviewSceneWithAssistant,
		startBackgroundReview
	} from '$lib/assistant-actions';
	import { openReviewModal } from '$lib/review-modal.svelte';
	import { REVIEW_CATEGORIES } from '$lib/review-shape';
	import { flashActivity } from '$lib/activity.svelte';
	import { parseSseFrames } from '$lib/assistant-stream';
	import { commandsForScope, matchSlash, slashName, slashArgs } from '$lib/assistant-slash';
	import Icon from './Icon.svelte';
	import AssistantProposal, { type SplitProposal } from './AssistantProposal.svelte';
	import { dismiss } from '$lib/dismiss';

	let {
		scope,
		sceneId = null,
		name,
		muted = false,
		suggestions = [],
		initialMessages = [],
		onConfirmSplit,
		onRevertSplit,
		onInsert,
		onReplaceSelection,
		getSelection,
		reviewHref
	}: {
		// The conversation this panel serves: a single story (Write, Review, story
		// Plan) or the whole universe (universe Plan). The story scope carries the
		// editor affordances (recap, summaries, mute, insert, split); the universe
		// scope is chat and cross-story grounding only.
		scope: { storyId: string; storyTitle: string } | { universeId: string; universeName: string };
		// The open scene, sent as the focus of context assembly; null off a scene
		// and on the universe surface.
		sceneId?: string | null;
		// The Assistant's display name, shown over its replies.
		name: string;
		// This story has muted the Assistant; the tab stays to un-mute. Story scope
		// only - the universe surface has no per-universe mute.
		muted?: boolean;
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
		// Confirms a proposed scene split; resolves to the created scene pair (the
		// page navigates to the new scene) or an error message.
		onConfirmSplit?: (proposal: {
			sceneId: string;
			before: string;
		}) => Promise<{ error: string } | { splitSceneId: string; newSceneId: string }>;
		// Reverts a confirmed split: the two halves merge back into one scene.
		onRevertSplit?: (proposal: {
			sceneId: string;
			before: string;
			confirmed: { splitSceneId: string; newSceneId: string };
		}) => Promise<string | null>;
		// Inserts a reply's text into the open scene editor at the cursor; only
		// passed when a single scene editor is open.
		onInsert?: (text: string) => void;
		// Replaces the editor's current selection with a reply's text; the /rewrite
		// command's affordance. Passed alongside getSelection when a scene editor is
		// open.
		onReplaceSelection?: (text: string) => void;
		// The editor's current selection text, or null when nothing is selected.
		// /rewrite needs it; only passed when a scene editor is open.
		getSelection?: () => string | null;
		// The story's review page, for /copyedit to open when notes are staged.
		// Story surfaces pass it; the universe surface does not.
		reviewHref?: string;
	} = $props();

	type ChatReference = { sceneId: string; text: string };
	type Message = {
		role: 'user' | 'assistant';
		content: string;
		reference?: ChatReference;
		proposals?: SplitProposal[];
		// A /rewrite reply: its affordance replaces the selection rather than
		// inserting at the cursor.
		rewrite?: boolean;
	};
	type StreamEvent =
		| { type: 'token'; text: string }
		| { type: 'proposal'; proposal: SplitProposal }
		| { type: 'done' }
		| { type: 'error'; message: string };

	// The scope discriminant and its pieces. Fixed for the panel's life (a
	// surface does not change scope), so plain consts off the prop.
	// svelte-ignore state_referenced_locally
	const isStory = 'storyId' in scope;
	// svelte-ignore state_referenced_locally
	const scopeTitle = 'storyId' in scope ? scope.storyTitle : scope.universeName;

	// The scope fields the request bodies carry: the story or the universe.
	function scopeBody(): { storyId: string } | { universeId: string } {
		return 'storyId' in scope ? { storyId: scope.storyId } : { universeId: scope.universeId };
	}

	// Seeded once at mount from the stored conversation, falling back to a
	// synthesized opening line (which is never stored); the transcript is then
	// client-held until the next mount picks up the persisted turns.
	const opening = isStory
		? `I've read your codex for ${scopeTitle}. Ask me about your characters, check continuity, or work a scene.`
		: `I've read your codex for ${scopeTitle}. Ask me anything across its stories - characters, places, lore, or continuity between the books.`;
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

	// The panel is conditionally rendered (tab switches, scenes without an
	// Assistant tab); navigating away mid-stream must abort the reader loop
	// instead of leaving it consuming into orphaned state.
	$effect(() => {
		return () => pending?.abort();
	});

	$effect(() => {
		// Re-read on every transcript change, including the streaming reply's
		// growing text, so the newest words stay in view while tokens arrive.
		void messages.length;
		void messages[messages.length - 1]?.content;
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
			const result = await onConfirmSplit({
				sceneId: proposal.sceneId,
				before: proposal.before
			});
			if ('error' in result) proposal.error = result.error;
			else proposal.confirmed = result;
		} catch {
			proposal.error = 'Could not split the scene. Try again.';
		} finally {
			proposal.confirming = false;
		}
	}

	async function revertSplit(proposal: SplitProposal) {
		if (!onRevertSplit || !proposal.confirmed || proposal.reverting) return;
		proposal.reverting = true;
		proposal.error = '';
		try {
			const failure = await onRevertSplit({
				sceneId: proposal.sceneId,
				before: proposal.before,
				confirmed: proposal.confirmed
			});
			if (failure) proposal.error = failure;
			else proposal.confirmed = undefined;
		} catch {
			proposal.error = 'Could not merge the scenes back. Try again.';
		} finally {
			proposal.reverting = false;
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
				const { events, rest } = parseSseFrames<StreamEvent>(buffer);
				buffer = rest;
				for (const event of events) {
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
		if (!question) return;
		// A line that starts with "/" is a command, not a message to the model.
		if (question.startsWith('/')) {
			runSlashCommand(question);
			return;
		}
		if (busy) return;
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
			...scopeBody(),
			...(isStory ? { sceneId } : {}),
			messages: turns
				.slice(-40)
				.map((m) => ({ role: m.role, content: m.content, reference: m.reference }))
		});
	}

	function runSlashCommand(raw: string) {
		input = '';
		if (composer) composer.style.height = 'auto';
		slashSelected = 0;
		const name = slashName(raw);
		switch (name) {
			case 'clear':
				void clearConversation();
				break;
			case 'write':
				void coauthorDraft(slashArgs(raw));
				break;
			case 'rewrite':
				void rewriteSelection(slashArgs(raw));
				break;
			case 'review':
				openReviewModal(sceneId ? { level: 'scene', sceneId } : { level: 'story' });
				break;
			case 'copyedit':
				void copyedit();
				break;
			case 'who':
				askWho(slashArgs(raw));
				break;
			case 'find':
				askFind(slashArgs(raw));
				break;
			case 'catchup':
			case 'catch-up':
				void catchUp();
				break;
			case 'summaries':
				void updateSummaries();
				break;
			case 'help':
				messages = [
					...messages,
					{
						role: 'assistant',
						content:
							'Commands you can type here:\n\n' +
							commandsForScope(!isStory)
								.map((c) => `/${c.name} - ${c.detail}`)
								.join('\n')
					}
				];
				break;
			default:
				messages = [
					...messages,
					{
						role: 'assistant',
						content: `I do not know the command "/${name}". Type /help to see the commands.`
					}
				];
		}
	}

	// Choosing a command from the hint menu. A command that takes arguments leaves
	// "/name " in the composer to type the argument into; the rest run straightaway.
	function chooseSlash(command: { name: string; args?: boolean }) {
		if (command.args) {
			input = `/${command.name} `;
			slashSelected = 0;
			composer?.focus();
			return;
		}
		runSlashCommand(`/${command.name}`);
	}

	// A plain assistant message, for usage hints and command errors.
	function assistantSay(content: string) {
		messages = [...messages, { role: 'assistant', content }];
	}

	// POST a brief (and optional selection) to the buffered co-author endpoint and
	// fill the empty assistant reply already pushed. Shared by /write and /rewrite;
	// the endpoint returns the whole passage as JSON, not a token stream.
	async function runCoauthor(
		payload: {
			storyId: string;
			sceneId: string | null;
			instruction: string;
			reference?: { kind: 'selection'; text: string };
		},
		opts: { rewrite?: boolean } = {}
	) {
		busy = true;
		const controller = new AbortController();
		pending = controller;
		try {
			const response = await fetch('/api/assistant/coauthor', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				signal: controller.signal
			});
			const reply = messages[messages.length - 1];
			if (!(reply && reply.role === 'assistant')) return;
			if (!response.ok) {
				reply.content = 'Sorry, the Assistant could not draft that passage. Try again.';
				return;
			}
			const { text } = (await response.json()) as { text?: string };
			reply.content = text?.trim() || 'The Assistant did not return a passage.';
			if (opts.rewrite) reply.rewrite = true;
		} catch {
			if (!controller.signal.aborted) {
				const reply = messages[messages.length - 1];
				if (reply && reply.role === 'assistant') {
					reply.content = 'Sorry, something went wrong reaching the Assistant.';
				}
			}
		} finally {
			busy = false;
			pending = null;
		}
	}

	// /write: draft a passage from a brief through the co-author endpoint (the same
	// one the toolbar Write button uses), shown as a reply the writer can insert.
	// Needs a story focus; the universe surface has no scene to draft into.
	async function coauthorDraft(brief: string) {
		if (!('storyId' in scope)) {
			assistantSay('Drafting needs an open story or scene. Open a story to use /write.');
			return;
		}
		if (!brief) {
			assistantSay('Add a brief after the command, like "/write a tense standoff at the gate".');
			return;
		}
		if (busy) return;
		messages = [
			...messages,
			{ role: 'user', content: `/write ${brief}` },
			{ role: 'assistant', content: '' }
		];
		await runCoauthor({ storyId: scope.storyId, sceneId, instruction: brief });
	}

	// /rewrite: co-author a rewrite of the editor's current selection to an
	// instruction. Needs an open scene editor and a live selection; the reply's
	// affordance replaces the selection rather than inserting at the cursor.
	async function rewriteSelection(how: string) {
		if (!('storyId' in scope)) {
			assistantSay('Rewriting needs an open scene. Open a scene to use /rewrite.');
			return;
		}
		if (!getSelection) {
			assistantSay('Open a scene in the editor to use /rewrite.');
			return;
		}
		const selection = getSelection()?.trim();
		if (!selection) {
			assistantSay('Select the passage you want rewritten first, then type /rewrite.');
			return;
		}
		if (!how) {
			assistantSay('Say how to rewrite it, like "/rewrite tighten this and cut the adverbs".');
			return;
		}
		if (busy) return;
		const ask: Message = { role: 'user', content: `/rewrite ${how}` };
		if (sceneId) ask.reference = { sceneId, text: selection };
		messages = [...messages, ask, { role: 'assistant', content: '' }];
		await runCoauthor(
			{
				storyId: scope.storyId,
				sceneId,
				instruction: how,
				reference: { kind: 'selection', text: selection }
			},
			{ rewrite: true }
		);
	}

	// /copyedit: kick a full mechanics + prose + lore review at the current scope,
	// a fast path versus the review modal. Reuses the background review flow;
	// story focus only.
	async function copyedit() {
		if (!('storyId' in scope) || !reviewHref) {
			assistantSay('A copyedit runs on an open story. Open a story to use /copyedit.');
			return;
		}
		const categories = [...REVIEW_CATEGORIES];
		if (sceneId) {
			await reviewSceneWithAssistant(sceneId, reviewHref, categories, 'this scene');
		} else {
			await startBackgroundReview({
				storyId: scope.storyId,
				categories,
				label: 'your story',
				reviewHref
			});
		}
	}

	// /who: show a character or place sheet inline, a templated chat send that
	// leans on the tool-enabled chat (get_entity). Works in both scopes.
	function askWho(who: string) {
		if (!who) {
			assistantSay('Name who to look up, like "/who Marra".');
			return;
		}
		void send(`Show me a short sheet for ${who}: the key facts you have on them.`);
	}

	// /find: search the universe and list hits, a templated send backed by the
	// universe-scoped search_text tool. Works in both scopes.
	function askFind(query: string) {
		if (!query) {
			assistantSay('Say what to search for, like "/find the obsidian coins".');
			return;
		}
		void send(
			`Search this universe for "${query}" and list what you find, with where each turns up.`
		);
	}

	// The hint menu: the matching commands while the composer holds a bare "/word",
	// narrowed to this surface's scope.
	let slashSelected = $state(0);
	const slashMatches = $derived(matchSlash(input, !isStory));
	const slashOpen = $derived(slashMatches.length > 0 && !busy);
	$effect(() => {
		if (slashSelected >= slashMatches.length) slashSelected = 0;
	});

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
		// Recap is "the story so far"; there is no universe-wide recap, so the
		// universe surface has no catch-up.
		if (busy || !('storyId' in scope)) return;
		messages = [...messages, { role: 'assistant', content: '' }];
		await streamInto('/api/assistant/recap', { storyId: scope.storyId, sceneId });
	}

	// Update summaries: a background pass that drafts and refreshes scene and
	// chapter summaries. It runs unattended, so this only kicks it off and
	// confirms; the writer is notified when it finishes.
	let summarising = $state(false);
	async function updateSummaries() {
		// Summary maintenance is per story; the universe surface does not offer it.
		if (summarising || !('storyId' in scope)) return;
		summarising = true;
		try {
			await startSummariesJob(scope.storyId);
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
		clearing = true;
		try {
			const response = await fetch('/api/assistant/chat', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(scopeBody())
			});
			if (!response.ok) {
				flashActivity('failed', 'Could not clear the conversation', 'Try again in a moment.');
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

	function onKeydown(event: KeyboardEvent) {
		if (slashOpen) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				slashSelected = Math.min(slashSelected + 1, slashMatches.length - 1);
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				slashSelected = Math.max(slashSelected - 1, 0);
				return;
			}
			if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
				event.preventDefault();
				chooseSlash(slashMatches[slashSelected]);
				return;
			}
		}
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
				{#if isStory}
					<form method="POST" action="?/muteAssistant" use:enhance>
						<button class="mute-link" type="submit" title="Hide the Assistant for this story">
							Mute for this story
						</button>
					</form>
				{/if}
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
						{#if message.content && !(busy && index === messages.length - 1) && index > 0}
							{#if message.rewrite && onReplaceSelection}
								<button
									class="msg-insert"
									type="button"
									title="Replace the selected passage with this rewrite"
									onclick={() => onReplaceSelection(message.content)}
								>
									<Icon name="plus" size={12} /> Replace selection
								</button>
							{:else if onInsert}
								<button
									class="msg-insert"
									type="button"
									title="Insert this reply into the scene at the cursor"
									onclick={() => onInsert(message.content)}
								>
									<Icon name="plus" size={12} /> Insert at cursor
								</button>
							{/if}
						{/if}
						{#each message.proposals ?? [] as proposal, pi (pi)}
							<AssistantProposal
								{proposal}
								onConfirm={onConfirmSplit ? () => confirmSplit(proposal) : undefined}
								onRevert={onRevertSplit ? () => revertSplit(proposal) : undefined}
							/>
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
		{#if slashOpen}
			<div class="slash-menu" role="listbox" aria-label="Commands">
				{#each slashMatches as command, index (command.name)}
					<button
						class="slash-item"
						class:active={index === slashSelected}
						role="option"
						aria-selected={index === slashSelected}
						type="button"
						onmouseenter={() => (slashSelected = index)}
						onclick={() => chooseSlash(command)}
					>
						<span class="slash-name">/{command.name}</span>
						<span class="slash-detail">{command.detail}</span>
					</button>
				{/each}
			</div>
		{/if}
		<div class="composer">
			<textarea
				bind:this={composer}
				rows="1"
				placeholder="Ask about your story, or type / for commands..."
				value={input}
				oninput={grow}
				onkeydown={onKeydown}
			></textarea>
			<div
				class="composer-menu-wrap"
				use:dismiss={{ enabled: actionsOpen, close: () => (actionsOpen = false) }}
			>
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
					<div class="composer-menu popover" role="menu">
						{#if isStory}
							<button
								class="menu-item"
								type="button"
								role="menuitem"
								disabled={busy}
								title="Recap the story up to where you are"
								onclick={() => runAction(() => void catchUp())}
							>
								Catch me up
							</button>
							<button
								class="menu-item"
								type="button"
								role="menuitem"
								disabled={summarising}
								title="Draft and refresh scene and chapter summaries in the background"
								onclick={() => runAction(() => void updateSummaries())}
							>
								{summarising ? 'Starting...' : 'Update summaries'}
							</button>
						{/if}
						<button
							class="menu-item"
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
	.slash-menu {
		margin: 0 12px 6px;
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--bg-elevated);
		box-shadow: var(--shadow);
		padding: 5px;
		display: flex;
		flex-direction: column;
	}
	.slash-item {
		display: flex;
		align-items: baseline;
		gap: 9px;
		width: 100%;
		text-align: left;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--font-ui);
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
	}
	.slash-item.active {
		background: var(--bg-hover);
	}
	.slash-name {
		flex: 0 0 auto;
		font-family: var(--font-mono);
		font-size: 12.5px;
		font-weight: 550;
	}
	.slash-detail {
		font-size: 12px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
	/* Skin from the shared .popover / .menu-item (menus.css); only the
	   positioning stays here. */
	.composer-menu {
		position: absolute;
		bottom: 42px;
		right: 0;
		z-index: 60;
		min-width: 190px;
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
