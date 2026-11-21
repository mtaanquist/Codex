<script lang="ts" module>
	import { untrack } from 'svelte';
	import type {
		ChatAttachment,
		ChatModelInfo,
		ChatModelSettings,
		ChatSummary
	} from '#lib/assistant-chat';
	import type { SplitProposal } from './AssistantProposal.svelte';

	export type StopReason = 'context' | 'budget';
	export type StoredChatTurn = {
		role: 'user' | 'assistant';
		content: string;
		meta: {
			reference?: { sceneId: string; text: string };
			attachments?: ChatAttachment[];
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
		sceneDraftPath,
		startContinuityReview,
		startEnrichJob
	} from '#lib/assistant-actions';
	import { openReviewModal } from '#lib/review-modal.svelte';
	import type { WaitingDraft } from '#lib/scene-draft';
	import { REVIEW_CATEGORIES } from '#lib/review-shape';
	import { flashActivity, pollPause } from '#lib/activity.svelte';
	import { parseSseFrames } from '#lib/assistant-stream';
	import { renderReplyBlocks } from '#lib/markdown';
	import {
		attachmentKey,
		attachmentLabel,
		parseAttachedHeader,
		chatEffort,
		MAX_ATTACHMENTS,
		type AttachmentEntityType,
		type AttachmentKind,
		CHAT_MISSING,
		CHAT_STORED_HEADER,
		NO_REPLY_TEXT,
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
		findAsk,
		matchCommands,
		whoAsk,
		SLASH_COMMANDS,
		matchSlash,
		slashName,
		hasStrayArgs,
		isSlashCommand,
		slashQuery,
		slashArgs,
		type SlashCommand
	} from '#lib/assistant-slash';
	import Icon from './Icon.svelte';
	import AssistantProposal from './AssistantProposal.svelte';
	import AssistantDraft from './AssistantDraft.svelte';
	import AssistantChapterDraft from './AssistantChapterDraft.svelte';
	import AssistantCommandMenu from './AssistantCommandMenu.svelte';
	import AssistantModelMenu, { EFFORT_LABELS } from './AssistantModelMenu.svelte';
	import AssistantContextPicker from './AssistantContextPicker.svelte';
	import type { IconName } from './Icon.svelte';
	import { dismiss } from '#lib/dismiss';

	let {
		scope,
		sceneId = null,
		chapterId = null,
		name,
		muted = false,
		off = false,
		revisionPreview = false,
		suggestions = [],
		chat = null,
		onConfirmSplit,
		onRevertSplit,
		onInsert,
		onReplaceSelection,
		insertPaused = false,
		getSelection,
		onLandDraft,
		onDraftDecided,
		waitingDrafts = [],
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
		// The chapter the open scene is in, for a chapter draft.
		chapterId?: string | null;
		// The Assistant's display name, shown over its replies.
		name: string;
		// This story has muted the Assistant; the tab stays to un-mute. Story scope
		// only - the universe surface has no per-universe mute.
		muted?: boolean;
		// The Assistant is off for the account. The panel is then only here for
		// drafts written before, to keep or discard.
		off?: boolean;
		// An earlier version of the scene is open in Write, so nothing is drafted.
		revisionPreview?: boolean;
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
		// Keeps a scene draft, as the writer chose: into the open scene while it
		// is empty (fill) or as a new scene after it (add). Resolves to a message
		// when it did not go through. Only Write passes it, so only Write drafts.
		onLandDraft?: (
			draftId: string,
			action: 'fill' | 'add',
			text: string,
			baseHashes: string[]
		) => Promise<string | null>;
		// Called once a draft is kept or discarded, and while the list of
		// waiting drafts may be out of date, for the page to read them again.
		onDraftDecided?: () => void;
		// The story's undecided drafts, listed while the Assistant is off so the
		// ones on other scenes can be reached.
		waitingDrafts?: WaitingDraft[];
		// The story's review page, for /copyedit to open when notes are staged.
		// Story surfaces pass it; the universe surface does not.
		reviewHref?: ResolvedPathname;
	} = $props();

	type ChatReference = { sceneId: string; text: string };
	const ATTACHMENT_ICONS: Record<AttachmentKind, IconName> = {
		scene: 'scene',
		chapter: 'chapter',
		entity: 'user',
		note: 'note',
		story: 'book'
	};
	const ENTITY_ICONS: Record<AttachmentEntityType, IconName> = {
		character: 'user',
		place: 'pin',
		lore: 'feather'
	};
	function attachmentIcon(attachment: ChatAttachment): IconName {
		return attachment.kind === 'entity' && attachment.entityType
			? ENTITY_ICONS[attachment.entityType]
			: ATTACHMENT_ICONS[attachment.kind];
	}
	type Message = {
		role: 'user' | 'assistant';
		content: string;
		reference?: ChatReference;
		attachments?: ChatAttachment[];
		proposals?: SplitProposal[];
		// The reply was cut short; a note under it says why.
		stopped?: StopReason;
		// The server did not store this reply, so it is not sent back as history.
		unsaved?: boolean;
		// An error or a hint rather than the Assistant's writing: it cannot be
		// inserted.
		notice?: boolean;
		// Why a reply with some text broke off; a note under it says so. What
		// arrived can still be inserted.
		failed?: string;
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
	// A reply cut short before any text shows a line in its place, as a notice:
	// it is not text to insert, and it is not sent back as history.
	function standIn(
		content: string,
		stopped: StopReason | undefined,
		proposals: number
	): { content: string; notice?: boolean } {
		if (content.trim() === '' && stopped && proposals === 0) {
			return { content: NO_REPLY_TEXT, notice: true };
		}
		return { content };
	}
	function toMessages(stored: StoredChatTurn[]): Message[] {
		const seeded = stored.map((m) => ({
			role: m.role,
			...standIn(m.content, m.meta?.stopped, m.meta?.proposals?.length ?? 0),
			reference: m.meta?.reference,
			attachments: m.meta?.attachments,
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
	const chipEffort = $derived(chatEffort(chatSettings, modelInfo));
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

	// The last reply was not stored; `notice` when it is an error rather than
	// writing the writer may want to insert.
	function markUnsaved(notice: boolean) {
		const last = messages[messages.length - 1];
		if (last && last.role === 'assistant') {
			last.unsaved = true;
			if (notice) last.notice = true;
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
	// then. Returns 'gone' when the open chat no longer exists, and 'refused'
	// when the server turned the request away before storing anything (a rate
	// limit, a setting, a bad request), with the reason in the reply.
	async function streamInto(
		url: string,
		payload: object,
		title: string,
		storesTurnFirst: boolean
	): Promise<'gone' | 'refused' | 'unreached' | void> {
		busy = true;
		const controller = new AbortController();
		pending = controller;
		let startedIn: string | null = null;
		let finished = false;
		let storedTitle = title;
		const creating = chatId === null;
		// A chat message is stored before its reply, so a stopped send leaves its
		// turn in the chat the next send reuses.
		const hadEarlierSend = nextChatMayExist;
		if (creating && storesTurnFirst) nextChatMayExist = true;
		let reached = false;
		// A chat this request started without the chip's choice (a recap) is
		// given it once adopted, so the chip and the chat agree.
		const adopt = (id: string) => {
			noteChatUsed(id, storedTitle);
			if (creating && !('settings' in payload) && Object.keys(chatSettings).length > 0) {
				saveSettings($state.snapshot(chatSettings), {});
			}
		};
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...payload, chatId, ...(chatId ? {} : { newChatId: nextChatId }) }),
				signal: controller.signal
			});
			reached = true;
			if (response.headers.get('x-chat-summarised') === '1') olderSummarised = true;
			applyAttached(response.headers.get('x-chat-attachments'));
			const storedIn = response.headers.get('x-chat-id');
			const serverTitle = response.headers.get('x-chat-title');
			if (serverTitle) storedTitle = decodeURIComponent(serverTitle);
			// A chat an earlier, stopped send started already holds a turn, so it
			// is kept whatever happens to this reply.
			const existed = response.headers.get('x-chat-created') === '0';
			if (response.ok && storedIn) {
				if (storesTurnFirst || existed || chatId === storedIn) adopt(storedIn);
				else startedIn = storedIn;
			}
			const failure = response.ok ? '' : await errorMessage(response);
			if (response.status === 404 && failure === CHAT_MISSING) {
				// The open chat was deleted elsewhere (another tab).
				const gone = chatId;
				chats = chats.filter((c) => c.id !== gone);
				chatId = null;
				freshChatId();
				chatSettings = {};
				messages = [
					{ role: 'assistant', content: 'This chat was deleted.', unsaved: true, notice: true }
				];
				olderSummarised = false;
				return 'gone';
			}
			if (
				(response.status >= 400 && response.status < 500) ||
				response.headers.get(CHAT_STORED_HEADER) === '0'
			) {
				appendToReply(failure || 'The Assistant could not take that request.');
				markUnsaved(true);
				// Nothing was stored by this send, so it left no chat behind.
				if (creating && !hadEarlierSend) nextChatMayExist = false;
				return 'refused';
			}
			if (!response.ok || !response.body) {
				appendToReply(
					'Sorry, I could not reach the Assistant. Check the endpoint in your account settings.'
				);
				markUnsaved(true);
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
					else if (event.type === 'stopped') markStopped(event.reason);
					else if (event.type === 'error') streamError = event.message;
					else if (event.type === 'done') finished = true;
				}
			}
			const reply = messages[messages.length - 1];
			// The server sends done once it has stored the reply, and stores one
			// that has text, a proposal or a cut-short note.
			const stored =
				finished &&
				!streamError &&
				reply?.role === 'assistant' &&
				(reply.content.trim() !== '' || (reply.proposals?.length ?? 0) > 0 || !!reply.stopped);
			if (stored) {
				Object.assign(reply, standIn(reply.content, reply.stopped, reply.proposals?.length ?? 0));
			}
			if (startedIn && stored) adopt(startedIn);
			if (reply?.role === 'assistant' && !stored) {
				// Not stored, so not sent back. Text that broke off can still be
				// inserted; an error in its place cannot.
				reply.unsaved = true;
				if (reply.content.trim() === '') {
					reply.content = streamError || NO_REPLY_TEXT;
					reply.notice = true;
				} else reply.failed = streamError || 'The connection closed before the reply finished.';
			}
		} catch {
			const reply = messages[messages.length - 1];
			if (finished && reply?.role === 'assistant' && reply.content.trim() !== '') {
				// A Stop or a dropped connection after done: the reply is stored.
				if (startedIn) adopt(startedIn);
			} else if (controller.signal.aborted) {
				// A writer's own Stop keeps what arrived to insert, but the server
				// stored none of it.
				markUnsaved(false);
			} else if (reply?.role === 'assistant' && reply.content.trim() !== '') {
				markUnsaved(false);
				reply.failed = 'The connection to the Assistant was lost.';
			} else {
				appendToReply('Sorry, something went wrong reaching the Assistant.');
				markUnsaved(true);
				// No answer at all (offline, a dropped connection): nothing was stored.
				if (!reached) return 'unreached';
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

	// `typed` is the line as the writer typed it, when `text` was built from it
	// (/who, /find); a send that does not go out puts that back.
	async function send(text?: string, typed?: string) {
		const line = (text ?? input).trim();
		if (!line) return;
		// A line that starts with "/" is a command, not a message to the model;
		// a space in front of the "/" makes it a message.
		if ((text ?? input).startsWith('/')) {
			// Commands wait for the reply in progress, and the line stays put.
			if ((busy || switching) && !runsWhileBusy(line)) return;
			runSlashCommand(line);
			return;
		}
		// A model just picked is saved before the message goes, so it answers;
		// the draft is read after the wait, so nothing typed meanwhile is lost.
		// A pick made during the wait queues another save, so wait for them all.
		while (settingsSaving) await settingsSaving;
		if (busy || switching) {
			// A /who or /find line the chat box already gave up goes back.
			if (typed) restoreDraft(typed, {});
			return;
		}
		const question = (text ?? input).trim();
		if (!question || (text ?? input).startsWith('/')) return;
		// Text passed in (a starter suggestion) leaves the writer's draft alone.
		if (text === undefined) {
			input = '';
			if (composer) composer.style.height = 'auto';
		}
		const turn: Message = { role: 'user', content: question };
		if (reference) {
			turn.reference = reference;
			reference = null;
		}
		if (attachments.length > 0) {
			turn.attachments = attachments;
			attachments = [];
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
				// A reply the server did not store is not sent back either.
				messages: turns
					.filter((m) => !m.unsaved && !m.notice && m.content.trim() !== '')
					.slice(-CHAT_WINDOW_TURNS)
					.map((m) => ({
						role: m.role,
						content: m.content,
						reference: m.reference,
						attachments: m.attachments
					})),
				// A stored chat keeps its choice through the chip's own save, so a
				// stale tab cannot overwrite it; a new chat sends it to be stored.
				...(chatId ? {} : { settings: $state.snapshot(chatSettings) })
			},
			chatTitle(question),
			true
		);
		// Turned away before it was stored: the message comes off the transcript
		// and goes back in the chat box, with what it carried.
		if (outcome === 'refused' || outcome === 'unreached') {
			const reply = messages[messages.length - 1];
			messages = [
				// The turn and its reply are the last two.
				...messages.slice(0, -2),
				{
					role: 'assistant',
					// With no answer at all, the message may still have arrived.
					content:
						outcome === 'unreached'
							? 'Your message may not have been sent. It is back in the chat box.'
							: `Your message was not sent. ${reply?.content ?? ''} It is back in the chat box.`,
					unsaved: true,
					notice: true
				}
			];
		}
		// Not sent: start afresh, and put the question (and its passage) back so
		// it need not be typed again.
		if (outcome === 'gone') {
			messages = [
				{
					role: 'assistant',
					content:
						'This chat was deleted. Your message was not sent; send it again to start a new chat.',
					unsaved: true,
					notice: true
				}
			];
		}
		// A message that starts with "/" keeps the space that made it a message.
		if (outcome)
			restoreDraft(typed ?? (question.startsWith('/') ? ` ${question}` : question), turn);
	}

	// Puts a message that did not go out back in the chat box, alongside
	// anything typed or added since: its text first, its context merged in.
	function restoreDraft(
		text: string,
		turn: { reference?: ChatReference; attachments?: ChatAttachment[] }
	) {
		if (turn.reference && !reference) reference = turn.reference;
		if (turn.attachments) {
			const keys = new Set(attachments.map(attachmentKey));
			const missing = turn.attachments.filter((a) => !keys.has(attachmentKey(a)));
			attachments = [...missing, ...attachments].slice(0, MAX_ATTACHMENTS);
		}
		const current = input.trim();
		if (current === text) return;
		const value = current ? `${text}\n\n${current}` : text;
		input = value;
		if (composer) {
			composer.value = value;
			fit(composer);
		}
	}

	// `typed` says the line came from the chat box, which it then clears; a
	// command chosen from the menu leaves the writer's draft alone.
	// A model or context popover opened by a command returns focus to the chat
	// box when it closes; one opened by its button returns it to the button.
	let popoverFromComposer = false;
	// These only open a popover, so they need not wait for a reply in progress.
	// Only the bare command: anything else would answer with a message, and a
	// message added now would take the rest of the reply being written.
	function runsWhileBusy(raw: string): boolean {
		if (switching || slashArgs(raw) !== '') return false;
		const name = slashName(raw);
		return name === 'context' || (name === 'model' && !settingsLocked);
	}
	// The commands that do nothing without words after them, and what to say.
	const NEEDS_WORDS: Record<string, string> = {
		who: 'Name who to look up, like "/who Marra".',
		find: 'Say what to search for, like "/find the obsidian coins".'
	};
	function runSlashCommand(raw: string, typed = true) {
		commandSelected = 0;
		const name = slashName(raw);
		// Not a command (a path, a subreddit, a typo): the line stays in the
		// chat box to correct or reword.
		if (!isSlashCommand(raw)) {
			assistantSay(
				`I do not know the command "/${name}". Type /help to see the commands. To send a message that starts with "/", put a space in front of it.`
			);
			return;
		}
		// Words after a command that takes none: more likely a message, and
		// running the command would throw the line away.
		if (typed && hasStrayArgs(raw)) {
			assistantSay(
				`/${name} takes nothing after it, so it was not run. To send this as a message, put a space in front of the "/".`
			);
			return;
		}
		const story = SLASH_COMMANDS.find((c) => c.name === name)?.scope === 'story';
		if (story && !isStory) {
			assistantSay(`/${name} works in a story. Open a story to use it.`);
			return;
		}
		// A command that needs words and has none: the line stays to finish.
		const usage = NEEDS_WORDS[name];
		if (usage && !slashArgs(raw)) {
			assistantSay(usage);
			return;
		}
		if (typed) {
			input = '';
			if (composer) composer.style.height = 'auto';
		}
		// One popover at a time.
		if (name === 'history' || name === 'model' || name === 'context') {
			commandsOpen = false;
			modelOpen = false;
			contextOpen = false;
			// Opened from the chat box, so closing it goes back there.
			popoverFromComposer = true;
		}
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
			case 'context':
				contextOpen = true;
				break;
			// 'clear' is the command's old name, from before chats were kept.
			case 'new':
			case 'clear':
				newChat();
				break;
			// A /write or /rewrite that cannot go ahead, or fails, puts the
			// typed line back so the brief need not be typed again.
			case 'write':
				void coauthorDraft(slashArgs(raw)).then((done) => {
					if (!done && typed) restoreDraft(raw, {});
				});
				break;
			case 'rewrite':
				void rewriteSelection(slashArgs(raw)).then((done) => {
					if (!done && typed) restoreDraft(raw, {});
				});
				break;
			case 'draft':
				if (!openSceneDraft(slashArgs(raw)) && typed) restoreDraft(raw, {});
				break;
			case 'draft-chapter':
				if (!openChapterDraft(slashArgs(raw)) && typed) restoreDraft(raw, {});
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
				askWho(slashArgs(raw), raw);
				break;
			case 'find':
				askFind(slashArgs(raw), raw);
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
				assistantSay(
					'Commands you can type here:\n\n' +
						commandsForScope(!isStory)
							.filter(offered)
							.map((c) => `/${c.name} - ${c.detail}`)
							.join('\n')
				);
				break;
		}
	}

	// Choosing a command from the menu. A command that takes arguments leaves
	// "/name " in the composer to type the argument into; the rest run straightaway.
	// From the button menu the chat box may hold a draft, which is kept: a
	// command that takes input puts its name in front of it.
	function chooseCommand(command: SlashCommand) {
		const fromMenu = commandsOpen;
		commandsOpen = false;
		commandSelected = 0;
		// The filter field is about to go; commands that open something move
		// focus on from here.
		composer?.focus();
		const draft = fromMenu ? input.trim() : '';
		if (command.args) {
			setComposer(`/${command.name} ${draft}`);
			return;
		}
		// Like a typed command, it waits for the reply in progress.
		if ((busy || switching) && !runsWhileBusy(`/${command.name}`)) {
			if (draft) {
				flashActivity(
					'failed',
					'Wait for the reply',
					'Choose the command again when the reply has finished.'
				);
			} else setComposer(`/${command.name}`);
			return;
		}
		runSlashCommand(`/${command.name}`, !fromMenu);
	}

	// A plain assistant message, for usage hints and command errors.
	function assistantSay(content: string) {
		messages = [...messages, { role: 'assistant', content, unsaved: true, notice: true }];
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
	): Promise<boolean> {
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
			if (!(reply && reply.role === 'assistant')) return true;
			if (!response.ok) {
				reply.content =
					'Sorry, the Assistant could not draft that passage. The command is back in the chat box to try again.';
				markUnsaved(true);
				return false;
			}
			const { text } = (await response.json()) as { text?: string };
			reply.content = text?.trim() || 'The Assistant did not return a passage.';
			if (!text?.trim()) markUnsaved(true);
			else if (opts.rewrite) reply.rewrite = true;
			return true;
		} catch {
			if (controller.signal.aborted) {
				markUnsaved(false);
				return true;
			}
			const reply = messages[messages.length - 1];
			if (reply && reply.role === 'assistant') {
				reply.content =
					'Sorry, something went wrong reaching the Assistant. The command is back in the chat box to try again.';
				markUnsaved(true);
			}
			return false;
		} finally {
			busy = false;
			pending = null;
		}
	}

	// /write: draft a passage from a brief through the co-author endpoint (the same
	// one the toolbar Write button uses), shown as a reply the writer can insert.
	// Needs a story focus; the universe surface has no scene to draft into.
	async function coauthorDraft(brief: string): Promise<boolean> {
		if (!('storyId' in scope)) {
			assistantSay('Drafting needs an open story or scene. Open a story to use /write.');
			return false;
		}
		if (!brief) {
			assistantSay('Add a brief after the command, like "/write a tense standoff at the gate".');
			return false;
		}
		if (busy || switching) return false;
		messages = [
			...messages,
			{ role: 'user', content: `/write ${brief}` },
			{ role: 'assistant', content: '' }
		];
		return runCoauthor({ storyId: scope.storyId, sceneId, instruction: brief });
	}

	// /draft and "Draft this scene": the brief form for a draft of the whole
	// open scene, in a card under the chat (AssistantDraft). The draft is
	// written by a background job and staged; the card is where the writer
	// keeps or discards it. Only ever opened by the writer asking for it.
	let draftRequest = $state<{ brief: string; sceneId: string; showOnly?: boolean } | null>(null);
	// Why nothing can be drafted here, when it cannot.
	function draftingRefusal(command: string): string | null {
		if (revisionPreview) {
			return `You are looking at an earlier version of this scene. Go back to the current text to use ${command}.`;
		}
		if (!('storyId' in scope) || !onLandDraft) {
			return `Drafting works in Write. Open your story there to use ${command}.`;
		}
		return null;
	}
	function openSceneDraft(brief: string, showOnly = false): boolean {
		const refusal = showOnly ? null : draftingRefusal('/draft');
		if (refusal) {
			assistantSay(refusal);
			return false;
		}
		if (!sceneId) {
			assistantSay('Open the scene you want drafted, then type /draft.');
			return false;
		}
		draftRequest = { brief, sceneId, showOnly };
		return true;
	}

	// /draft-chapter and "Draft this chapter": the brief form for a draft of
	// every scene in a chapter, in its own card (AssistantChapterDraft). The
	// command drafts the chapter the open scene is in; the chapter's menu names
	// the chapter itself. Each drafted scene is then decided in its scene's card.
	let chapterRequest = $state<{ brief: string; chapterId: string; showOnly?: boolean } | null>(
		null
	);
	// The chapter asked for, which stays the one shown after the request is
	// taken, until a scene in another chapter is opened.
	let askedChapterId = $state<string | null>(null);
	function openChapterDraft(
		brief: string,
		forChapter: string | null = chapterId,
		showOnly = false
	): boolean {
		const refusal = showOnly ? null : draftingRefusal('/draft-chapter');
		if (refusal) {
			assistantSay(refusal);
			return false;
		}
		if (!forChapter) {
			assistantSay(
				'Open a scene in the chapter you want drafted, then type /draft-chapter. You can also right-click the chapter in the left sidebar and choose Assistant, then "Draft this chapter...".'
			);
			return false;
		}
		askedChapterId = forChapter;
		chapterRequest = { brief, chapterId: forChapter, showOnly };
		return true;
	}
	// Counts scene drafts kept or discarded, so the chapter's list keeps up.
	let draftsDecided = $state(0);
	// The chapter whose drafts show: the one asked for, else the open scene's.
	const draftChapterId = $derived(askedChapterId ?? chapterId);
	// Opening a scene in another chapter moves the card on to that chapter.
	let seenChapterId = untrack(() => chapterId);
	$effect(() => {
		if (chapterId === seenChapterId) return;
		seenChapterId = chapterId;
		chapterRequest = null;
		askedChapterId = null;
	});

	// /rewrite: co-author a rewrite of the editor's current selection to an
	// instruction. Needs an open scene editor and a live selection; the reply's
	// affordance replaces the selection rather than inserting at the cursor.
	async function rewriteSelection(how: string): Promise<boolean> {
		if (!('storyId' in scope)) {
			assistantSay('Rewriting needs an open scene. Open a scene to use /rewrite.');
			return false;
		}
		if (!getSelection) {
			assistantSay('Open a scene in the editor to use /rewrite.');
			return false;
		}
		const selection = getSelection()?.trim();
		if (!selection) {
			assistantSay('Select the passage you want rewritten first, then type /rewrite.');
			return false;
		}
		if (!how) {
			assistantSay('Say how to rewrite it, like "/rewrite tighten this and cut the adverbs".');
			return false;
		}
		if (busy || switching) return false;
		const ask: Message = { role: 'user', content: `/rewrite ${how}` };
		if (sceneId) ask.reference = { sceneId, text: selection };
		messages = [...messages, ask, { role: 'assistant', content: '' }];
		return runCoauthor(
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
	function askWho(who: string, typed: string) {
		void send(whoAsk(who), typed);
	}

	// /find: search the universe and list hits, a templated send backed by the
	// universe-scoped search_text tool. Works in both scopes.
	function askFind(query: string, typed: string) {
		void send(findAsk(query), typed);
	}

	// The command menu. Typing "/word" in the composer opens it filtered by the
	// word (Escape hides it until the word changes); the "/" button opens it with
	// a filter field of its own. Either way the highlighted row is commandSelected.
	let commandSelected = $state(0);
	// The + context picker and the model menu, declared here because the
	// typed-command menu stays shut while either is open.
	let contextOpen = $state(false);
	let modelOpen = $state(false);
	let commandsOpen = $state(false);
	let commandQuery = $state('');
	let commandsTrigger = $state<HTMLButtonElement>();
	let slashDismissed = $state<string | null>(null);
	// The drafting commands are only offered where a draft can be kept.
	const offered = (command: SlashCommand) =>
		Boolean(onLandDraft) || (command.name !== 'draft' && command.name !== 'draft-chapter');
	const slashMatches = $derived(matchSlash(input, !isStory).filter(offered));
	// One popover at a time: a "/" typed while another is open waits for it.
	const slashOpen = $derived(
		!commandsOpen &&
			!contextOpen &&
			!modelOpen &&
			slashMatches.length > 0 &&
			!busy &&
			slashDismissed !== input
	);
	const shownCommands = $derived(
		commandsOpen
			? matchCommands(commandQuery, !isStory).filter(offered)
			: slashOpen
				? slashMatches
				: []
	);
	$effect(() => {
		if (commandSelected >= shownCommands.length) commandSelected = 0;
	});
	// A new typed filter starts at its first match, so Enter never runs a row
	// highlighted under the earlier filter.
	const typedQuery = $derived(slashQuery(input));
	$effect(() => {
		void typedQuery;
		commandSelected = 0;
	});
	function toggleCommands() {
		commandsOpen = !commandsOpen;
		commandQuery = '';
		commandSelected = 0;
		if (commandsOpen) {
			modelOpen = false;
			contextOpen = false;
		}
	}
	// The keys of whichever field drives the menu. True when the key was used.
	function commandKey(event: KeyboardEvent): boolean {
		const count = shownCommands.length;
		if (event.key === 'ArrowDown' && count > 0) {
			commandSelected = (commandSelected + 1) % count;
		} else if (event.key === 'ArrowUp' && count > 0) {
			commandSelected = (commandSelected - 1 + count) % count;
		} else if (event.key === 'Enter' && !event.shiftKey && count > 0) {
			chooseCommand(shownCommands[commandSelected]);
		} else if (event.key === 'Tab' && !event.shiftKey && count > 0 && !commandsOpen) {
			// Tab completes the name and runs nothing; once it is complete, Tab
			// moves on as usual.
			const command = shownCommands[commandSelected];
			const done = `/${command.name}${command.args ? ' ' : ''}`;
			if (input === done || input === `/${command.name}`) return false;
			setComposer(done);
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
	// In the menu's own filter field Tab leaves the menu rather than run a
	// command; only Enter or a click runs one.
	function filterKeydown(event: KeyboardEvent) {
		if (event.key === 'Tab') {
			commandsTrigger?.focus();
			commandsOpen = false;
			return;
		}
		commandKey(event);
	}

	// A chat already stored keeps the new choice straightaway; a new chat
	// sends it with its first message.
	// Saves go one at a time, newest wins, so quick clicks cannot land out of
	// order; while another chat loads the choice would go to the wrong one.
	// A new chat's first message carries its choice, so the choice is locked
	// until that message is stored. Saves run one after another so the newest
	// lands last; if the newest fails, the earlier choice comes back.
	let settingsSaving: Promise<void> | null = null;
	// The choice the server last stored for the open chat, which a failed save
	// goes back to; null until a save is in flight.
	let storedSettings: ChatModelSettings | null = null;
	let storedFor: string | null = null;
	const settingsLocked = $derived(switching || (busy && !chatId));
	$effect(() => {
		if (settingsLocked && untrack(() => modelOpen)) {
			modelOpen = false;
			composer?.focus();
		}
	});
	function changeSettings(next: ChatModelSettings) {
		if (settingsLocked) return;
		const previous = chatSettings;
		chatSettings = next;
		if (chatId) saveSettings(next, previous);
	}
	function saveSettings(next: ChatModelSettings, previous: ChatModelSettings) {
		const savingFor = chatId;
		// A save queued behind one in flight starts from an unsaved pick, so the
		// stored choice is the one from before the first of them.
		if (!settingsSaving || storedFor !== savingFor) {
			storedSettings = previous;
			storedFor = savingFor;
		}
		const failed = () => {
			if (settingsSaving !== saving) return;
			if (chatId === savingFor)
				chatSettings = (storedFor === savingFor && storedSettings) || previous;
			flashActivity(
				'failed',
				'Could not save the model',
				'The chat keeps its earlier model. Try again in a moment.'
			);
		};
		const saving: Promise<void> = (settingsSaving ?? Promise.resolve())
			.then(() =>
				fetch(`/api/assistant/chats/${savingFor}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ settings: next })
				})
			)
			.then((response) => {
				if (!response.ok) failed();
				else if (storedFor === savingFor) storedSettings = next;
			})
			.catch(failed)
			.finally(() => {
				if (settingsSaving === saving) settingsSaving = null;
			});
		settingsSaving = saving;
	}

	// What the next message carries as context, from the + button; chips in
	// the composer until it is sent.
	let attachments = $state<ChatAttachment[]>([]);
	let contextTrigger = $state<HTMLButtonElement>();
	const contextListId = `assistant-context-${newChatId().slice(0, 8)}`;
	function addAttachment(attachment: ChatAttachment) {
		contextOpen = false;
		composer?.focus();
		if (attachments.some((a) => attachmentKey(a) === attachmentKey(attachment))) {
			flashActivity('done', 'Already added', `${attachmentLabel(attachment)} is already attached.`);
			return;
		}
		if (attachments.length >= MAX_ATTACHMENTS) {
			flashActivity(
				'failed',
				'Too much context',
				`A message can carry up to ${MAX_ATTACHMENTS} items. Remove one first.`
			);
			return;
		}
		attachments = [...attachments, attachment];
	}
	function toggleContext() {
		popoverFromComposer = false;
		contextOpen = !contextOpen;
		if (contextOpen) {
			commandsOpen = false;
			modelOpen = false;
		}
	}
	// The server says which of the newest message's attachments it sent and
	// which it had to cut; the chips follow, so they match what was stored.
	function applyAttached(header: string | null) {
		if (header === null) return;
		const sent = parseAttachedHeader(header);
		const turn = messages.findLast((m) => m.role === 'user');
		if (!turn?.attachments) return;
		const kept = turn.attachments.filter((a) => sent.has(attachmentKey(a)));
		for (const a of kept) {
			const stored = sent.get(attachmentKey(a))!;
			if (stored.shortened) a.shortened = true;
			// The name as stored, which follows a rename since it was picked.
			if (stored.label !== undefined) a.label = stored.label;
		}
		const dropped = turn.attachments.length - kept.length;
		turn.attachments = kept;
		if (dropped > 0) {
			flashActivity(
				'failed',
				'Context left out',
				dropped === 1
					? 'One attached item is gone or hidden from the Assistant, so it was not sent.'
					: `${dropped} attached items are gone or hidden from the Assistant, so they were not sent.`
			);
		}
	}

	// The model menu, from the chip in the composer.
	let modelTrigger = $state<HTMLButtonElement>();
	const commandListId = `assistant-commands-${newChatId().slice(0, 8)}`;

	// The story's waiting drafts that are not on the open scene (that one has
	// its card).
	const draftsElsewhere = $derived(waitingDrafts.filter((waiting) => waiting.sceneId !== sceneId));
	const WAITING_STATE: Partial<Record<WaitingDraft['status'], string>> = {
		pending: 'Being written',
		running: 'Being written',
		ready: 'Ready',
		failed: 'Not written'
	};
	// A draft in the list that is still being written changes on its own, so
	// while there is one the page's data is read again every few seconds.
	let listPollSince: number | null = null;
	// Derived, so the wait below starts over only when the answer changes, not
	// each time the page's data is read again.
	const listWriting = $derived(
		muted &&
			draftsElsewhere.some(
				(waiting) => waiting.status === 'pending' || waiting.status === 'running'
			)
	);
	$effect(() => {
		if (!listWriting) {
			listPollSince = null;
			return;
		}
		// Paced from when a draft was first seen being written, so a long one
		// is checked less often.
		const since = (listPollSince ??= Date.now());
		let live = true;
		void (async () => {
			for (;;) {
				await pollPause(since);
				if (!live) return;
				onDraftDecided?.();
			}
		})();
		return () => {
			live = false;
		};
	});

	// Where the keyboard goes when a draft card closes: the chat box, or the
	// scene's text while the Assistant is off and there is no chat box.
	function focusAfterDraft() {
		if (composer) composer.focus();
		else document.querySelector<HTMLElement>('.cm-content')?.focus();
	}

	// The mute switch is a form action; the command menu submits it.
	let muteForm = $state<HTMLFormElement>();

	// Intents raised by the editor menus or the command palette: the page has
	// already switched the right pane here; the panel acts on the intent.
	$effect(() => {
		const intent = assistantIntent.pending;
		if (!intent) return;
		if (muted) {
			// Nothing is asked of the Assistant while it is off, but a link to a
			// draft written before still shows it.
			if (intent.kind === 'draft') {
				assistantIntent.pending = null;
				if (sceneId && !intent.gone) draftRequest = { brief: '', sceneId, showOnly: true };
			} else if (intent.kind === 'draft-chapter') {
				assistantIntent.pending = null;
				openChapterDraft('', intent.chapterId, true);
			}
			return;
		}
		assistantIntent.pending = null;
		if (intent.kind === 'reference') {
			reference = { sceneId: intent.sceneId, text: intent.text };
			composer?.focus();
		} else if (intent.kind === 'prefill') {
			prefill(intent.text);
		} else if (intent.kind === 'draft') {
			if (intent.gone) assistantSay('The scene that draft was for is no longer in this story.');
			else openSceneDraft('', intent.showOnly);
		} else if (intent.kind === 'draft-chapter') {
			openChapterDraft('', intent.chapterId, intent.showOnly);
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
		if (deleting || busy || switching) return;
		// A new chat with nothing stored has nothing to delete. A stopped first
		// send may have stored its question, so that one is asked about too.
		if (!chatId && !nextChatMayExist) {
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
		if (!ok || deleting || busy || switching) return;
		const unopened = chatId === null;
		if (unopened && !nextChatMayExist) return;
		deleting = true;
		const id = chatId ?? nextChatId;
		try {
			const response = await fetch(`/api/assistant/chats/${id}`, { method: 'DELETE' });
			// The stopped send may have stored nothing, and then there is no chat.
			if (!response.ok && !(unopened && response.status === 404)) {
				flashActivity('failed', 'Could not delete the chat', 'Try again in a moment.');
				return;
			}
			chats = chats.filter((c) => c.id !== id);
			// Like a new chat, the composer's draft (text, passage, context) stays.
			newChat();
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

<!-- The drafts waiting on the open scene and its chapter. They show while the
     Assistant is off too: a draft already written can still be kept. -->
{#snippet draftCards()}
	{#if 'storyId' in scope && sceneId && onLandDraft}
		<!-- One per scene: it shows the scene's draft, if it has one. -->
		{#key sceneId}
			<AssistantDraft
				storyId={scope.storyId}
				{sceneId}
				request={draftRequest?.sceneId === sceneId ? draftRequest : null}
				canDraft={!muted}
				onLand={onLandDraft}
				onDecided={() => {
					draftsDecided += 1;
					onDraftDecided?.();
				}}
				onRequestTaken={() => (draftRequest = null)}
				onClose={focusAfterDraft}
			/>
		{/key}
	{/if}
	{#if 'storyId' in scope && draftChapterId && onLandDraft}
		<!-- One per chapter: it shows the chapter's drafts, if it has any. -->
		{#key draftChapterId}
			<AssistantChapterDraft
				storyId={scope.storyId}
				chapterId={draftChapterId}
				request={chapterRequest?.chapterId === draftChapterId ? chapterRequest : null}
				canDraft={!muted}
				decided={draftsDecided}
				onRequestTaken={() => (chapterRequest = null)}
				onClose={focusAfterDraft}
			/>
		{/key}
	{/if}
{/snippet}

{#if muted}
	<div class="assistant-muted">
		{#if off}
			<p>The Assistant is off for your account.</p>
			<p class="muted-hint">
				Drafts it wrote before are still here to keep or discard. To use the Assistant again, turn
				it on under Account, Assistant.
			</p>
		{:else}
			<p>The Assistant is off for this story.</p>
			<p class="muted-hint">
				Turn it back on to chat about this book, review scenes, and write alongside it.
			</p>
			<form method="POST" action="?/unmuteAssistant" use:enhance>
				<button class="btn btn-primary" type="submit">Turn on for this story</button>
			</form>
		{/if}
		<div class="muted-drafts">
			{@render draftCards()}
			{#if 'storyId' in scope && draftsElsewhere.length > 0}
				<p class="muted-drafts-head" id="muted-drafts-head">
					{sceneId ? 'Drafts on other scenes' : 'Drafts in this story'}
				</p>
				<ul class="muted-drafts-list" aria-labelledby="muted-drafts-head">
					{#each draftsElsewhere as waiting (waiting.sceneId)}
						<li>
							<a href={sceneDraftPath(scope.storyId, waiting.sceneId)}>
								{waiting.sceneTitle || 'Untitled scene'}
							</a>
							<span class="muted-drafts-state">{WAITING_STATE[waiting.status] ?? ''}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
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
							class="input sm"
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
						{#if message.attachments?.length}
							<div class="msg-attachments">
								{#each message.attachments as attachment (`${attachment.kind}-${attachment.id}-${attachment.depth}`)}
									<span
										class="msg-attachment"
										title={attachment.shortened
											? `${attachmentLabel(attachment)}: cut to fit what the model can read at once`
											: attachmentLabel(attachment)}
									>
										<Icon name={attachmentIcon(attachment)} size={11} />
										{attachmentLabel(attachment)}{attachment.shortened ? ' (shortened)' : ''}
									</span>
								{/each}
							</div>
						{/if}{#if message.reference}
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
								<!-- One piece per top-level block, so a reply that is still arriving
								     only redraws the block being written; what is above it stays put,
								     selection and all. -->
								{#each renderReplyBlocks(message.content) as block, at (at)}
									<!-- eslint-disable-next-line svelte/no-at-html-tags (reply renderer escapes raw HTML) -->
									{@html block}
								{/each}
							{/if}
						</div>
						{#if message.content && !message.notice && !(busy && index === messages.length - 1) && index > 0}
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
						{#if message.failed}
							<p class="stopped-note">
								This reply was not saved. {message.failed}
							</p>
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
			{@render draftCards()}
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
				enabled: commandsOpen || modelOpen || contextOpen,
				close: () => {
					commandsOpen = false;
					modelOpen = false;
					contextOpen = false;
				},
				refocus: () => {
					if (document.activeElement === composer) return;
					if (!commandsOpen && popoverFromComposer) composer?.focus();
					else
						(commandsOpen ? commandsTrigger : contextOpen ? contextTrigger : modelTrigger)?.focus();
				}
			}}
		>
			{#if commandsOpen || slashOpen}
				<!-- A press on the typed menu (its scrollbar included) must not blur
				     the chat box, which would close it. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="composer-pop"
					onmousedown={(event) => {
						if (!commandsOpen) event.preventDefault();
					}}
				>
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
			{#if contextOpen}
				<div class="composer-pop">
					<AssistantContextPicker
						id={contextListId}
						model={chipModel || undefined}
						onAdd={addAttachment}
						onClose={() => {
							(popoverFromComposer ? composer : contextTrigger)?.focus();
							contextOpen = false;
						}}
					/>
				</div>
			{/if}
			{#if modelOpen}
				<div class="composer-pop">
					<AssistantModelMenu
						info={modelInfo}
						storyId={'storyId' in scope ? scope.storyId : null}
						universeId={'universeId' in scope ? scope.universeId : null}
						settings={chatSettings}
						onChange={changeSettings}
						close={() => (modelOpen = false)}
						refocus={() => ((popoverFromComposer ? composer : modelTrigger) ?? composer)?.focus()}
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
					aria-autocomplete="list"
					aria-activedescendant={slashOpen && shownCommands[commandSelected]
						? `${commandListId}-${shownCommands[commandSelected].name}`
						: undefined}
					value={input}
					oninput={grow}
					onkeydown={onKeydown}
					onblur={() => (slashDismissed = input)}></textarea>
				<!-- A textarea cannot be a combobox, so the highlighted command is
				     read out from here as the writer types or moves through the list. -->
				<span class="visually-hidden" aria-live="polite">
					{#if slashOpen && shownCommands[commandSelected]}
						/{shownCommands[commandSelected].name}, {shownCommands[commandSelected].detail}
						({commandSelected + 1} of {shownCommands.length})
					{:else if slashOpen}
						No matching command
					{/if}
				</span>
				<div class="composer-row">
					<div class="composer-tools">
						<button
							bind:this={contextTrigger}
							class="icon-btn sm"
							type="button"
							title="Add context"
							aria-label="Add context"
							aria-haspopup="listbox"
							aria-expanded={contextOpen}
							onclick={toggleContext}
						>
							<Icon name="plus" size={15} />
						</button>
						<button
							bind:this={commandsTrigger}
							class="icon-btn sm"
							type="button"
							title="Chat commands (/)"
							aria-label="Chat commands"
							aria-haspopup="listbox"
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
							disabled={settingsLocked}
							onclick={() => {
								modelOpen = !modelOpen;
								popoverFromComposer = false;
								if (modelOpen) {
									commandsOpen = false;
									contextOpen = false;
								}
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
									onclick={() => {
										reference = null;
										composer?.focus();
									}}
								>
									x
								</button>
							</span>
						{/if}
						{#each attachments as attachment, index (`${attachment.kind}-${attachment.id}-${attachment.depth}`)}
							<span class="chip context-chip" title={attachmentLabel(attachment)}>
								<Icon name={attachmentIcon(attachment)} size={12} />
								<span class="context-chip-label">{attachmentLabel(attachment)}</span>
								<button
									class="chip-x"
									type="button"
									title="Remove {attachmentLabel(attachment)}"
									aria-label="Remove {attachmentLabel(attachment)}"
									onclick={() => {
										attachments = attachments.filter((_, i) => i !== index);
										composer?.focus();
									}}
								>
									x
								</button>
							</span>
						{/each}
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
		border-radius: var(--radius);
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
	.msg-attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-bottom: 6px;
	}
	.msg-attachment {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 1px 7px;
		border: 1px solid var(--accent-contrast);
		border-radius: 99px;
		font-size: var(--text-meta);
		opacity: 0.85;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
	/* Draft cards read left to right, under the centred note. */
	.muted-drafts {
		text-align: left;
	}
	.muted-drafts-head {
		font-size: 12.5px;
		font-weight: 600;
		margin: 16px 0 6px;
	}
	.muted-drafts-list {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 13px;
	}
	.muted-drafts-list li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 4px 0;
	}
	.muted-drafts-state {
		color: var(--text-faint);
		white-space: nowrap;
	}
	.assistant-muted .muted-hint {
		font-size: 12.5px;
		color: var(--text-faint);
		margin: 6px 0 16px;
	}
</style>
