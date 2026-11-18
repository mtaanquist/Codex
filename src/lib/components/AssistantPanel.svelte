<script lang="ts" module>
	import type { ChatSummary } from '#lib/assistant-chat';
	import type { SplitProposal } from './AssistantProposal.svelte';

	export type StopReason = 'context' | 'budget';
	export type StoredChatTurn = {
		role: 'user' | 'assistant';
		content: string;
		meta: {
			reference?: { sceneId: string; text: string };
			proposals?: Omit<SplitProposal, 'confirming' | 'error'>[];
			stopped?: StopReason;
		} | null;
	};
	// The writer's chats for this scope and the one the panel opens with, as the
	// page load returns them (loadAssistantChat).
	export type AssistantChatData = {
		chats: ChatSummary[];
		chatId: string | null;
		messages: StoredChatTurn[];
		summarised: boolean;
	};
</script>

<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	// The right pane's Assistant tab: a chat with the writing Assistant,
	// grounded in the open story. A writer keeps any number of chats per story
	// (or universe); the server stores each completed turn, the page load opens
	// the most recent chat, and the picker at the top switches between them.
	// The server holds the key and endpoint; this only POSTs the transcript and
	// streams tokens back over Server-Sent Events.
	import { enhance } from '#lib/enhance';
	import { assistantIntent } from '#lib/assistant.svelte';
	import { askConfirm } from '#lib/confirm.svelte';
	import {
		startSummariesJob,
		reviewSceneWithAssistant,
		startBackgroundReview,
		startContinuityReview,
		startEnrichJob
	} from '#lib/assistant-actions';
	import { openReviewModal } from '#lib/review-modal.svelte';
	import { REVIEW_CATEGORIES } from '#lib/review-shape';
	import { flashActivity } from '#lib/activity.svelte';
	import { parseSseFrames } from '#lib/assistant-stream';
	import { renderReplyMarkdown } from '#lib/markdown';
	import { CHAT_WINDOW_TURNS, chatTitle, RECAP_CHAT_TITLE } from '#lib/assistant-chat';
	import { relativeShort } from '#lib/format';
	import { now } from '#lib/now.svelte';
	import { page } from '$app/state';
	import { commandsForScope, matchSlash, slashName, slashArgs } from '#lib/assistant-slash';
	import Icon from './Icon.svelte';
	import AssistantProposal from './AssistantProposal.svelte';
	import { dismiss } from '#lib/dismiss';
	import { menu } from '#lib/menu';

	let {
		scope,
		sceneId = null,
		name,
		muted = false,
		suggestions = [],
		chat = null,
		onConfirmSplit,
		onRevertSplit,
		onInsert,
		onReplaceSelection,
		insertPaused = false,
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
		// The stored chats, loaded with the page; the panel seeds from them at
		// mount and keeps its own copy from there.
		chat?: AssistantChatData | null;
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
		// The scene is saving and swapping; Insert and Replace wait for it.
		insertPaused?: boolean;
		// The editor's current selection text, or null when nothing is selected.
		// /rewrite needs it; only passed when a scene editor is open.
		getSelection?: () => string | null;
		// The story's review page, for /copyedit to open when notes are staged.
		// Story surfaces pass it; the universe surface does not.
		reviewHref?: ResolvedPathname;
	} = $props();

	type ChatReference = { sceneId: string; text: string };
	type Message = {
		role: 'user' | 'assistant';
		content: string;
		reference?: ChatReference;
		proposals?: SplitProposal[];
		// The reply was cut short; a note under it says why.
		stopped?: StopReason;
		// A /rewrite reply: its affordance replaces the selection rather than
		// inserting at the cursor.
		rewrite?: boolean;
	};
	type StreamEvent =
		| { type: 'token'; text: string }
		| { type: 'proposal'; proposal: SplitProposal }
		| { type: 'stopped'; reason: StopReason }
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
	function toMessages(stored: StoredChatTurn[]): Message[] {
		const seeded = stored.map((m) => ({
			role: m.role,
			content: m.content,
			reference: m.meta?.reference,
			proposals: m.meta?.proposals?.map((p) => ({ ...p })),
			stopped: m.meta?.stopped
		}));
		return seeded.length > 0 ? seeded : [{ role: 'assistant', content: opening }];
	}
	// svelte-ignore state_referenced_locally
	let messages = $state<Message[]>(toMessages(chat?.messages ?? []));
	// svelte-ignore state_referenced_locally
	let olderSummarised = $state(chat?.summarised ?? false);
	// The scope's chats, newest first, and the open one; null until the first
	// message of a new chat comes back with the id the server gave it.
	// svelte-ignore state_referenced_locally
	let chats = $state<ChatSummary[]>(chat?.chats ?? []);
	// svelte-ignore state_referenced_locally
	let chatId = $state<string | null>(chat?.chatId ?? null);
	const currentTitle = $derived(chats.find((c) => c.id === chatId)?.title || 'New chat');
	let input = $state('');
	let busy = $state(false);
	// An earlier chat is loading; nothing is sent until it is in place, or the
	// message would go to the chat being left.
	let switching = $state(false);
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

	function markStopped(reason: StopReason) {
		const last = messages[messages.length - 1];
		if (last && last.role === 'assistant') last.stopped = reason;
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

	// A turn was stored in a chat: it moves to the top of the list, and a chat
	// the server just created joins it under the title the server gave it.
	function noteChatUsed(id: string, title: string) {
		const existing = chats.find((c) => c.id === id);
		const updated = { id, title: existing?.title ?? title, updatedAt: new Date().toISOString() };
		chats = [updated, ...chats.filter((c) => c.id !== id)];
		chatId = id;
	}

	// Stream a reply into the empty assistant message the caller has already
	// pushed. Shared by chat (send) and recap (catchUp): both POST JSON and read
	// the same token/done/error Server-Sent Event frames. `title` names the chat
	// if this request starts one. `storesTurnFirst` says the server stores the
	// writer's turn before the reply (a chat message), so a chat it starts is
	// kept whatever happens to the reply; otherwise (a recap) the server drops
	// the new chat again unless a reply is stored, so the panel only adopts it
	// then. Returns 'gone' when the open chat no longer exists.
	async function streamInto(
		url: string,
		payload: object,
		title: string,
		storesTurnFirst: boolean
	): Promise<'gone' | void> {
		busy = true;
		const controller = new AbortController();
		pending = controller;
		let startedIn: string | null = null;
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...payload, chatId }),
				signal: controller.signal
			});
			if (response.headers.get('x-chat-summarised') === '1') olderSummarised = true;
			const storedIn = response.headers.get('x-chat-id');
			if (response.ok && storedIn) {
				if (storesTurnFirst || chatId === storedIn) noteChatUsed(storedIn, title);
				else startedIn = storedIn;
			}
			if (response.status === 404 && chatId) {
				// The open chat was deleted elsewhere (another tab).
				const gone = chatId;
				chats = chats.filter((c) => c.id !== gone);
				chatId = null;
				appendToReply(
					'This chat was deleted. Your message was not sent; send it again to start a new chat.'
				);
				return 'gone';
			}
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
			let finished = false;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const { events, rest } = parseSseFrames<StreamEvent>(buffer);
				buffer = rest;
				for (const event of events) {
					if (event.type === 'token') appendToReply(event.text);
					else if (event.type === 'proposal') attachProposal(event.proposal);
					else if (event.type === 'stopped') markStopped(event.reason);
					else if (event.type === 'error') streamError = event.message;
					else if (event.type === 'done') finished = true;
				}
			}
			const reply = messages[messages.length - 1];
			// The same test the server applies before it stores a reply.
			const stored =
				finished &&
				reply?.role === 'assistant' &&
				(reply.content.trim() !== '' || (reply.proposals?.length ?? 0) > 0);
			if (startedIn && stored) noteChatUsed(startedIn, title);
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
		if (busy || switching) return;
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
		const outcome = await streamInto(
			'/api/assistant/chat',
			{
				...scopeBody(),
				...(isStory ? { sceneId } : {}),
				messages: turns
					.slice(-CHAT_WINDOW_TURNS)
					.map((m) => ({ role: m.role, content: m.content, reference: m.reference }))
			},
			chatTitle(question),
			true
		);
		// Not sent: put the question back so it need not be typed again.
		if (outcome === 'gone' && !input.trim()) {
			input = question;
			if (composer) {
				composer.value = question;
				fit(composer);
			}
		}
	}

	function runSlashCommand(raw: string) {
		input = '';
		if (composer) composer.style.height = 'auto';
		slashSelected = 0;
		const name = slashName(raw);
		switch (name) {
			// 'clear' is the command's old name, from before chats were kept.
			case 'new':
			case 'clear':
				newChat();
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
			case 'continuity-review':
				void continuityReview();
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
			case 'enrich':
				void enrichEntries();
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
		if (busy || switching) return;
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
		if (busy || switching) return;
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

	// /continuity-review: kick a standalone continuity pass at the current scope.
	// A story focus checks one story; the universe surface checks every story
	// against the others. Runs in the background; findings land as review notes on
	// the owning stories' scenes.
	async function continuityReview() {
		await startContinuityReview({
			scope: scopeBody(),
			label: isStory ? 'this story' : 'this universe',
			reviewHref: isStory ? reviewHref : undefined
		});
	}

	// /enrich: a background pass that suggests aliases, details, and summaries for
	// every entry in the universe with new prose to read. A story focus runs over
	// its universe. Suggestions wait in each entry's editor in Plan.
	async function enrichEntries() {
		await startEnrichJob(scopeBody(), isStory ? "this story's universe" : 'this universe');
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
		} else if (intent.kind === 'prefill') {
			prefill(intent.text);
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
		if (busy || switching || !('storyId' in scope)) return;
		messages = [...messages, { role: 'assistant', content: '' }];
		await streamInto(
			'/api/assistant/recap',
			{ storyId: scope.storyId, sceneId },
			RECAP_CHAT_TITLE,
			false
		);
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

	// A new chat: an empty transcript that the server stores as a chat of its
	// own once the first message goes. The earlier chats stay in the picker.
	function newChat() {
		if (busy || switching) return;
		chatId = null;
		messages = [{ role: 'assistant', content: opening }];
		olderSummarised = false;
		pickerOpen = false;
		composer?.focus();
	}

	// Switch to an earlier chat, loading its turns from the server.
	async function openChat(id: string) {
		if (busy || switching) return;
		pickerOpen = false;
		if (id === chatId) return;
		switching = true;
		try {
			const response = await fetch(`/api/assistant/chats/${id}`);
			if (!response.ok) {
				flashActivity('failed', 'Could not open that chat', 'Try again in a moment.');
				return;
			}
			const loaded = (await response.json()) as {
				messages: StoredChatTurn[];
				summarised: boolean;
			};
			chatId = id;
			messages = toMessages(loaded.messages);
			olderSummarised = loaded.summarised;
		} finally {
			switching = false;
			composer?.focus();
		}
	}

	// Delete the open chat for good, then start a new one.
	let deleting = $state(false);
	async function deleteChat() {
		if (deleting || busy) return;
		if (!chatId) {
			newChat();
			return;
		}
		const ok = await askConfirm({
			title: 'Delete this chat?',
			body: 'The chat is deleted for good. Your other chats are kept.',
			confirmLabel: 'Delete chat',
			danger: true
		});
		// The menu item that asked is gone by now, so focus goes back to the
		// composer rather than being lost.
		composer?.focus();
		if (!ok || deleting || busy || !chatId) return;
		deleting = true;
		const id = chatId;
		try {
			const response = await fetch(`/api/assistant/chats/${id}`, { method: 'DELETE' });
			if (!response.ok) {
				flashActivity('failed', 'Could not delete the chat', 'Try again in a moment.');
				return;
			}
			chats = chats.filter((c) => c.id !== id);
			newChat();
			reference = null;
		} finally {
			deleting = false;
		}
	}

	// The chat picker: earlier chats, newest first, narrowed by a search over
	// their titles.
	let pickerOpen = $state(false);
	let pickerTrigger = $state<HTMLButtonElement>();
	let pickerSearch = $state<HTMLInputElement>();
	let chatQuery = $state('');
	const shownChats = $derived.by(() => {
		const query = chatQuery.trim().toLowerCase();
		return query ? chats.filter((c) => c.title.toLowerCase().includes(query)) : chats;
	});
	function togglePicker() {
		pickerOpen = !pickerOpen;
		if (pickerOpen) chatQuery = '';
	}
	$effect(() => {
		if (pickerOpen) pickerSearch?.focus();
	});

	// The actions menu next to the send button; closes like the other inline
	// menus, on an outside press or Escape.
	let actionsOpen = $state(false);
	let actionsTrigger = $state<HTMLButtonElement>();

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

	// The textarea's value is one-way bound, so it is written here directly to
	// be sized and to place the cursor at the end in the same tick.
	function prefill(text: string) {
		input = text;
		if (!composer) return;
		composer.value = text;
		fit(composer);
		composer.focus();
		composer.setSelectionRange(text.length, text.length);
	}

	function fit(el: HTMLTextAreaElement) {
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 120) + 'px';
	}

	function grow(event: Event) {
		const el = event.target as HTMLTextAreaElement;
		fit(el);
		input = el.value;
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
		<div class="chat-bar">
			<div
				class="chat-picker-wrap"
				use:dismiss={{
					enabled: pickerOpen,
					close: () => (pickerOpen = false),
					refocus: () => pickerTrigger?.focus()
				}}
			>
				<button
					bind:this={pickerTrigger}
					class="chat-picker-btn"
					type="button"
					title="Switch to an earlier chat"
					aria-label="{currentTitle}, switch chat"
					aria-haspopup="dialog"
					aria-expanded={pickerOpen}
					disabled={busy || switching}
					onclick={togglePicker}
				>
					<span class="chat-picker-title">{currentTitle}</span>
					<Icon name="caret" size={12} />
				</button>
				{#if pickerOpen}
					<div class="chat-picker popover" role="dialog" aria-label="Your chats">
						<input
							bind:this={pickerSearch}
							class="chat-search"
							type="search"
							placeholder="Search chats"
							aria-label="Search chats"
							bind:value={chatQuery}
						/>
						<div class="chat-list">
							{#each shownChats as item (item.id)}
								<button
									class="menu-item chat-row"
									type="button"
									aria-current={item.id === chatId ? 'true' : undefined}
									onclick={() => void openChat(item.id)}
								>
									<span class="chat-row-title">{item.title || 'Untitled chat'}</span>
									<span class="chat-row-time"
										>{relativeShort(item.updatedAt, page.data.timeZone, now())}</span
									>
								</button>
							{:else}
								<p class="chat-empty">
									{chats.length === 0 ? 'Your chats will be listed here.' : 'No chats match.'}
								</p>
							{/each}
						</div>
					</div>
				{/if}
			</div>
			<button
				class="icon-btn sm"
				type="button"
				title="New chat"
				aria-label="New chat"
				disabled={busy}
				onclick={newChat}
			>
				<Icon name="plus" size={14} />
			</button>
		</div>
		<div class="chat-scroll" bind:this={scroll} aria-live="polite" aria-atomic="false">
			{#if olderSummarised}
				<p class="summary-note">
					The Assistant now sees the older messages here as a summary, so it may not recall their
					exact wording. Type /new to start a new chat.
				</p>
			{/if}
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
						<div class="bubble reply-md">
							{#if message.content === '' && busy && index === messages.length - 1}
								<div class="typing"><i></i><i></i><i></i></div>
							{:else}
								<!-- eslint-disable-next-line svelte/no-at-html-tags (reply renderer escapes raw HTML) -->
								{@html renderReplyMarkdown(message.content)}
							{/if}
						</div>
						{#if message.content && !(busy && index === messages.length - 1) && index > 0}
							{#if message.rewrite && onReplaceSelection}
								<button
									class="msg-insert"
									type="button"
									title="Replace the selected passage with this rewrite"
									disabled={insertPaused}
									onclick={() => onReplaceSelection(message.content)}
								>
									<Icon name="plus" size={12} /> Replace selection
								</button>
							{:else if onInsert}
								<button
									class="msg-insert"
									type="button"
									title="Insert this reply into the scene at the cursor"
									disabled={insertPaused}
									onclick={() => onInsert(message.content)}
								>
									<Icon name="plus" size={12} /> Insert at cursor
								</button>
							{/if}
						{/if}
						{#if message.stopped === 'budget'}
							<p class="stopped-note">
								The Assistant ran out of lookups for this reply, so it may have missed something. To
								let it read more, raise Lookups per reply on your account page, under Assistant.
							</p>
						{:else if message.stopped === 'context'}
							<p class="stopped-note">
								The Assistant ran out of room to read more for this reply, so it may have missed
								something. Try asking about fewer scenes at once.
							</p>
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
				onkeydown={onKeydown}></textarea>
			<div
				class="composer-menu-wrap"
				use:dismiss={{
					enabled: actionsOpen,
					close: () => (actionsOpen = false),
					refocus: () => actionsTrigger?.focus()
				}}
			>
				<button
					bind:this={actionsTrigger}
					class="menu-btn"
					type="button"
					title="More actions"
					aria-label="More actions"
					aria-haspopup="menu"
					aria-expanded={actionsOpen}
					onclick={() => (actionsOpen = !actionsOpen)}
				>
					<Icon name="more" size={16} />
				</button>
				{#if actionsOpen}
					<div
						class="composer-menu popover"
						role="menu"
						use:menu={{
							close: () => (actionsOpen = false),
							refocus: () => actionsTrigger?.focus()
						}}
					>
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
							class="menu-item danger"
							type="button"
							role="menuitem"
							disabled={deleting || busy}
							title="Delete this chat for good"
							onclick={() => runAction(() => void deleteChat())}
						>
							Delete chat
						</button>
					</div>
				{/if}
			</div>
			{#if busy}
				<button
					class="icon-btn"
					type="button"
					title="Stop generating"
					aria-label="Stop generating"
					onclick={stop}
				>
					<span class="stop-glyph"></span>
				</button>
			{:else}
				<button
					class="icon-btn"
					type="button"
					disabled={!input.trim() || switching}
					title="Send"
					aria-label="Send"
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
	.chat-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--border);
	}
	.chat-picker-wrap {
		position: relative;
		flex: 1;
		min-width: 0;
	}
	.chat-picker-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
		border: 0;
		background: none;
		padding: 4px 6px;
		border-radius: 6px;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 13px;
		cursor: pointer;
	}
	.chat-picker-btn:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.chat-picker-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Skin from the shared .popover / .menu-item (menus.css); only the
	   positioning and the list's own layout stay here. */
	.chat-picker {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 30;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.chat-search {
		width: 100%;
		font: inherit;
		font-size: 13px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-card);
		color: var(--text);
	}
	.chat-list {
		max-height: 320px;
		overflow-y: auto;
	}
	.chat-row {
		justify-content: space-between;
	}
	.chat-row[aria-current='true'] {
		background: var(--bg-hover);
	}
	.chat-row-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chat-row-time {
		flex: none;
		font-size: 12px;
		color: var(--text-faint);
	}
	.chat-empty {
		margin: 4px 7px;
		font-size: 13px;
		color: var(--text-faint);
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
		background: var(--accent-fill);
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
	.msg-insert:hover:not(:disabled) {
		color: var(--accent-ink);
		text-decoration: underline;
	}
	.msg-insert:disabled {
		cursor: progress;
		opacity: 0.6;
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
	.stop-glyph {
		width: 11px;
		height: 11px;
		border-radius: 2px;
		background: currentColor;
	}
	.assistant-muted {
		padding: 28px 22px;
		text-align: center;
		color: var(--text-muted);
		font-size: 14px;
	}
	.stopped-note {
		font-size: 12px;
		color: var(--text-faint);
		margin: 4px 0 0;
	}
	.summary-note {
		font-size: 12px;
		color: var(--text-faint);
		text-align: center;
		margin: 0;
	}
	.assistant-muted .muted-hint {
		font-size: 12.5px;
		color: var(--text-faint);
		margin: 6px 0 16px;
	}
</style>
