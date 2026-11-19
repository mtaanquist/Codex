<script lang="ts" module>
	import type { ChatModelInfo, ChatModelSettings, ChatSummary } from '#lib/assistant-chat';
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
		settings: ChatModelSettings;
		model: ChatModelInfo;
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
	import {
		CHAT_MISSING,
		CHAT_WINDOW_TURNS,
		chatTitle,
		newChatId,
		RECAP_CHAT_TITLE,
		withPrompt
	} from '#lib/assistant-chat';
	import { relativeShort } from '#lib/format';
	import { now } from '#lib/now.svelte';
	import { page } from '$app/state';
	import {
		commandsForScope,
		matchCommands,
		matchSlash,
		slashName,
		slashArgs,
		type SlashCommand
	} from '#lib/assistant-slash';
	import { modelTakesEffort } from '#lib/assistant-tuning';
	import Icon from './Icon.svelte';
	import AssistantProposal from './AssistantProposal.svelte';
	import AssistantCommandMenu from './AssistantCommandMenu.svelte';
	import AssistantModelMenu, { EFFORT_LABELS } from './AssistantModelMenu.svelte';
	import { dismiss } from '#lib/dismiss';

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

	// The scope discriminant and its pieces. Fixed for the panel's life (every
	// page keys the panel on its scope id, so a new scope remounts it), so
	// plain consts off the prop.
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
	// The id the next new chat gets. The panel picks it, so a first message
	// stopped before the reply starts still lands in the chat the next one
	// goes to, rather than leaving the question in a chat of its own.
	let nextChatId = newChatId();
	// A send under nextChatId may have stored its turn there without the panel
	// learning so (stopped before the reply started).
	let nextChatMayExist = false;
	function freshChatId() {
		nextChatId = newChatId();
		nextChatMayExist = false;
	}
	const currentTitle = $derived(chats.find((c) => c.id === chatId)?.title || 'New chat');
	// The model and effort this chat runs on, from the model chip; empty runs on
	// the default. Sent with every message, and stored on the chat by the server.
	// svelte-ignore state_referenced_locally
	let chatSettings = $state<ChatModelSettings>(chat?.settings ?? {});
	// svelte-ignore state_referenced_locally
	const modelInfo: ChatModelInfo = chat?.model ?? { model: '', effort: null, claude: false };
	const chipModel = $derived(chatSettings.model ?? modelInfo.model);
	const chipEffort = $derived(
		modelInfo.claude && modelTakesEffort(chipModel)
			? (chatSettings.effort ?? modelInfo.effort ?? 'medium')
			: null
	);
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

	// The message of a refused request, or '' when its body is not JSON.
	async function errorMessage(response: Response): Promise<string> {
		try {
			const body = (await response.json()) as { message?: unknown };
			return typeof body.message === 'string' ? body.message : '';
		} catch {
			return '';
		}
	}

	// A turn was stored in a chat: it moves to the top of the list, and a chat
	// the server just created joins it under the title the server gave it.
	function noteChatUsed(id: string, title: string) {
		const existing = chats.find((c) => c.id === id);
		const updated = { id, title: existing?.title ?? title, updatedAt: new Date().toISOString() };
		chats = [updated, ...chats.filter((c) => c.id !== id)];
		chatId = id;
		if (id === nextChatId) freshChatId();
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
		let storedTitle = title;
		const creating = chatId === null;
		// A chat message is stored before its reply, so a stopped send leaves its
		// turn in the chat the next send reuses.
		if (creating && storesTurnFirst) nextChatMayExist = true;
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...payload, chatId, ...(chatId ? {} : { newChatId: nextChatId }) }),
				signal: controller.signal
			});
			if (response.headers.get('x-chat-summarised') === '1') olderSummarised = true;
			const storedIn = response.headers.get('x-chat-id');
			const serverTitle = response.headers.get('x-chat-title');
			if (serverTitle) storedTitle = decodeURIComponent(serverTitle);
			// A chat an earlier, stopped send started already holds a turn, so it
			// is kept whatever happens to this reply.
			const existed = response.headers.get('x-chat-created') === '0';
			if (response.ok && storedIn) {
				if (storesTurnFirst || existed || chatId === storedIn) noteChatUsed(storedIn, storedTitle);
				else startedIn = storedIn;
			}
			if (response.status === 404 && (await errorMessage(response)) === CHAT_MISSING) {
				// The open chat was deleted elsewhere (another tab).
				const gone = chatId;
				chats = chats.filter((c) => c.id !== gone);
				chatId = null;
				freshChatId();
				messages = [{ role: 'assistant', content: 'This chat was deleted.' }];
				olderSummarised = false;
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
			if (startedIn && stored) noteChatUsed(startedIn, storedTitle);
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
			// A recap that did not start its chat leaves it to be dropped by the
			// server, so the next send must not reuse its id.
			// A chat an earlier, stopped send stored a turn in is kept, so its id stays.
			if (creating && !storesTurnFirst && chatId === null && !nextChatMayExist) freshChatId();
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
			// Commands wait for the reply in progress, and the line stays put.
			if (busy || switching) return;
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
					.map((m) => ({ role: m.role, content: m.content, reference: m.reference })),
				settings: $state.snapshot(chatSettings)
			},
			chatTitle(question),
			true
		);
		// Not sent: start afresh, and put the question (and its passage) back so
		// it need not be typed again.
		if (outcome === 'gone') {
			messages = [
				{
					role: 'assistant',
					content:
						'This chat was deleted. Your message was not sent; send it again to start a new chat.'
				}
			];
			if (turn.reference && !reference) reference = turn.reference;
			if (!input.trim()) {
				input = question;
				if (composer) {
					composer.value = question;
					fit(composer);
				}
			}
		}
	}

	function runSlashCommand(raw: string) {
		input = '';
		if (composer) composer.style.height = 'auto';
		commandSelected = 0;
		const name = slashName(raw);
		switch (name) {
			case 'history':
				pickerOpen = true;
				chatQuery = '';
				break;
			case 'delete':
				void deleteChat();
				break;
			case 'mute':
				if (isStory) muteForm?.requestSubmit();
				break;
			case 'model':
				modelOpen = true;
				break;
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

	// Choosing a command from the menu. A command that takes arguments leaves
	// "/name " in the composer to type the argument into; the rest run straightaway.
	function chooseCommand(command: SlashCommand) {
		commandsOpen = false;
		commandSelected = 0;
		// The filter field is about to go; commands that open something move
		// focus on from here.
		composer?.focus();
		if (command.args) {
			setComposer(`/${command.name} `);
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

	// The command menu. Typing "/word" in the composer opens it filtered by the
	// word (Escape hides it until the word changes); the "/" button opens it with
	// a filter field of its own. Either way the highlighted row is commandSelected.
	let commandSelected = $state(0);
	let commandsOpen = $state(false);
	let commandQuery = $state('');
	let commandsTrigger = $state<HTMLButtonElement>();
	let slashDismissed = $state<string | null>(null);
	const slashMatches = $derived(matchSlash(input, !isStory));
	const slashOpen = $derived(
		!commandsOpen && slashMatches.length > 0 && !busy && slashDismissed !== input
	);
	const shownCommands = $derived(
		commandsOpen ? matchCommands(commandQuery, !isStory) : slashOpen ? slashMatches : []
	);
	$effect(() => {
		if (commandSelected >= shownCommands.length) commandSelected = 0;
	});
	function toggleCommands() {
		commandsOpen = !commandsOpen;
		commandQuery = '';
		commandSelected = 0;
		if (commandsOpen) modelOpen = false;
	}
	// The keys of whichever field drives the menu. True when the key was used.
	function commandKey(event: KeyboardEvent): boolean {
		const count = shownCommands.length;
		if (event.key === 'ArrowDown' && count > 0) {
			commandSelected = (commandSelected + 1) % count;
		} else if (event.key === 'ArrowUp' && count > 0) {
			commandSelected = (commandSelected - 1 + count) % count;
		} else if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) && count > 0) {
			chooseCommand(shownCommands[commandSelected]);
		} else if (event.key === 'Escape') {
			if (commandsOpen) {
				commandsOpen = false;
				commandsTrigger?.focus();
			} else {
				slashDismissed = input;
			}
			event.stopPropagation();
		} else {
			return false;
		}
		event.preventDefault();
		return true;
	}
	function filterKeydown(event: KeyboardEvent) {
		if (event.key === 'Tab' && shownCommands.length === 0) {
			commandsOpen = false;
			return;
		}
		commandKey(event);
	}

	// A chat already stored keeps the new choice straightaway; a new chat
	// sends it with its first message.
	function changeSettings(next: ChatModelSettings) {
		chatSettings = next;
		if (!chatId) return;
		void fetch(`/api/assistant/chats/${chatId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ settings: next })
		}).catch(() => {});
	}

	// The model menu, from the chip in the composer.
	let modelOpen = $state(false);
	let modelTrigger = $state<HTMLButtonElement>();
	const commandListId = `assistant-commands-${newChatId().slice(0, 8)}`;

	// The mute switch is a form action; the command menu submits it.
	let muteForm = $state<HTMLFormElement>();

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
		freshChatId();
		messages = [{ role: 'assistant', content: opening }];
		olderSummarised = false;
		chatSettings = {};
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
				settings: ChatModelSettings;
			};
			chatId = id;
			messages = toMessages(loaded.messages);
			olderSummarised = loaded.summarised;
			chatSettings = loaded.settings ?? {};
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
			// A stopped first send may have stored its question; it goes too.
			if (nextChatMayExist) {
				void fetch(`/api/assistant/chats/${nextChatId}`, { method: 'DELETE' }).catch(() => {});
			}
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

	function onKeydown(event: KeyboardEvent) {
		if (slashOpen && commandKey(event)) return;
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}

	// Up and down arrows move between the search box and the chat rows, Home
	// and End jump to the first and last row.
	function pickerKeydown(event: KeyboardEvent) {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
		const picker = event.currentTarget as HTMLElement;
		const rows = [...picker.querySelectorAll<HTMLButtonElement>('.chat-row')];
		if (rows.length === 0) return;
		const inSearch = event.target === pickerSearch;
		if (inSearch && (event.key === 'Home' || event.key === 'End')) return;
		const at = rows.indexOf(event.target as HTMLButtonElement);
		let next: HTMLElement | undefined;
		if (event.key === 'Home') next = rows[0];
		else if (event.key === 'End') next = rows[rows.length - 1];
		else if (event.key === 'ArrowDown') next = inSearch ? rows[0] : rows[at + 1];
		else next = at <= 0 ? pickerSearch : rows[at - 1];
		if (!next) return;
		event.preventDefault();
		next.focus();
	}

	// The textarea's value is one-way bound, so it is written here directly to
	// be sized and to place the cursor at the end in the same tick.
	let lastPrompt = '';
	function prefill(text: string) {
		const value = withPrompt(input, lastPrompt, text);
		lastPrompt = text;
		setComposer(value);
	}

	function setComposer(value: string) {
		input = value;
		if (!composer) return;
		composer.value = value;
		fit(composer);
		composer.focus();
		composer.setSelectionRange(value.length, value.length);
	}

	function fit(el: HTMLTextAreaElement) {
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 160) + 'px';
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
			<span class="chat-title" title={currentTitle}>{currentTitle}</span>
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
					class="icon-btn sm"
					type="button"
					title="Chat history"
					aria-label="Chat history"
					aria-haspopup="dialog"
					aria-expanded={pickerOpen}
					disabled={busy || switching}
					onclick={togglePicker}
				>
					<Icon name="clock" size={15} />
				</button>
				{#if pickerOpen}
					<div
						class="chat-picker popover"
						role="dialog"
						aria-label="Your chats"
						tabindex="-1"
						onkeydown={pickerKeydown}
					>
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
				<Icon name="chat-new" size={15} />
			</button>
			{#if isStory}
				<form bind:this={muteForm} method="POST" action="?/muteAssistant" use:enhance hidden></form>
			{/if}
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

		<!-- The dismiss area holds the menus and their triggers, so a press on a
		     trigger toggles its menu rather than closing and reopening it. -->
		<div
			class="composer-wrap"
			use:dismiss={{
				enabled: commandsOpen || modelOpen,
				close: () => {
					commandsOpen = false;
					modelOpen = false;
				},
				refocus: () => (commandsOpen ? commandsTrigger : modelTrigger)?.focus()
			}}
		>
			{#if commandsOpen || slashOpen}
				<div class="composer-pop">
					<AssistantCommandMenu
						id={commandListId}
						commands={shownCommands}
						selected={commandSelected}
						onChoose={chooseCommand}
						onHover={(index) => (commandSelected = index)}
						filter={commandsOpen
							? {
									value: commandQuery,
									onInput: (value) => {
										commandQuery = value;
										commandSelected = 0;
									},
									onKeydown: filterKeydown
								}
							: undefined}
					/>
				</div>
			{/if}
			{#if modelOpen}
				<div class="composer-pop">
					<AssistantModelMenu
						info={modelInfo}
						settings={chatSettings}
						onChange={changeSettings}
						close={() => (modelOpen = false)}
						refocus={() => (modelTrigger ?? composer)?.focus()}
					/>
				</div>
			{/if}
			<div class="composer">
				<textarea
					bind:this={composer}
					rows="1"
					placeholder={isStory ? 'Ask about your story' : 'Ask about this universe'}
					aria-label="Message the Assistant"
					aria-controls={slashOpen ? commandListId : undefined}
					aria-activedescendant={slashOpen && shownCommands[commandSelected]
						? `${commandListId}-${shownCommands[commandSelected].name}`
						: undefined}
					value={input}
					oninput={grow}
					onkeydown={onKeydown}></textarea>
				<div class="composer-row">
					<div class="composer-tools">
						<button
							bind:this={commandsTrigger}
							class="icon-btn sm"
							type="button"
							title="Chat commands (/)"
							aria-label="Chat commands"
							aria-haspopup="true"
							aria-expanded={commandsOpen}
							onclick={toggleCommands}
						>
							<Icon name="command" size={15} />
						</button>
						<button
							bind:this={modelTrigger}
							class="chip model-chip"
							class:custom={chatSettings.model || chatSettings.effort}
							type="button"
							title="Model for this chat"
							aria-label="Model for this chat, {chipModel || 'not set'}{chipEffort
								? `, ${EFFORT_LABELS[chipEffort]} effort`
								: ''}"
							aria-haspopup="menu"
							aria-expanded={modelOpen}
							onclick={() => {
								modelOpen = !modelOpen;
								if (modelOpen) commandsOpen = false;
							}}
						>
							<span class="model-chip-name">{chipModel || 'Model'}</span>
							{#if chipEffort}<span class="model-chip-effort">{EFFORT_LABELS[chipEffort]}</span
								>{/if}
						</button>
						{#if reference}
							<span class="chip context-chip" title={reference.text}>
								<Icon name="quote" size={12} />
								<span class="context-chip-label">{reference.text}</span>
								<button
									class="chip-x"
									type="button"
									title="Remove the passage"
									aria-label="Remove the passage"
									onclick={() => (reference = null)}
								>
									x
								</button>
							</span>
						{/if}
					</div>
					<span class="composer-send">
						{#if busy}
							<button
								class="icon-btn sm send-btn"
								type="button"
								title="Stop generating"
								aria-label="Stop generating"
								onclick={stop}
							>
								<span class="stop-glyph"></span>
							</button>
						{:else}
							<button
								class="icon-btn sm send-btn"
								type="button"
								disabled={!input.trim() || switching}
								title="Send"
								aria-label="Send"
								onclick={() => send()}
							>
								<Icon name="send" size={15} />
							</button>
						{/if}
					</span>
				</div>
			</div>
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
	/* The chat list drops below the whole header, as wide as the panel. */
	.chat-picker-wrap {
		flex: none;
	}
	/* Skin from the shared .popover / .menu-item (menus.css); only the
	   positioning and the list's own layout stay here. */
	.chat-picker {
		position: absolute;
		top: calc(100% + 4px);
		left: 8px;
		right: 8px;
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
		position: relative;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 6px 8px 6px 14px;
		border-bottom: 1px solid var(--border);
	}
	.chat-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text);
	}
	/* The composer: one bordered box holding the text and a row of controls.
	   The command and model menus open above it, as wide as the box. */
	.composer-wrap {
		position: relative;
		padding: 8px 12px 12px;
	}
	.composer-pop {
		position: absolute;
		left: 12px;
		right: 12px;
		bottom: calc(100% - 2px);
		z-index: 60;
	}
	.composer {
		display: flex;
		flex-direction: column;
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: 10px;
	}
	.composer:focus-within {
		border-color: var(--accent-line);
	}
	.composer textarea {
		resize: none;
		background: none;
		border: 0;
		padding: 10px 12px 4px;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: var(--text-base);
		line-height: 1.45;
		max-height: 160px;
		outline: none;
	}
	.composer-row {
		display: flex;
		align-items: flex-end;
		gap: 4px;
		padding: 4px 6px 6px;
		border-top: 1px solid var(--border);
	}
	.composer-tools {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.composer-row .chip {
		padding: 2px 8px;
		font-size: var(--text-meta);
		max-width: 100%;
		min-width: 0;
	}
	.model-chip {
		cursor: pointer;
	}
	.model-chip-name,
	.context-chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.model-chip-name {
		max-width: 16ch;
	}
	.context-chip-label {
		max-width: 18ch;
	}
	.model-chip-effort {
		color: var(--text-faint);
	}
	.model-chip.custom {
		border-color: var(--accent-line);
	}
	.composer-send {
		flex: none;
	}
	.send-btn:not(:disabled) {
		color: var(--accent-ink);
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
