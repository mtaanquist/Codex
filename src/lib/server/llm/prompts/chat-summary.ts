import type { ChatMessage } from '../providers/types';

// The running summary of a long side panel conversation: the older turns that
// no longer fit the transcript budget, condensed on the utility role. The
// result rides ahead of the newer turns as a system message.

export function buildChatSummaryMessage(previous: string | null, turns: ChatMessage[]): string {
	const transcript = turns
		.map((turn) => `${turn.role === 'user' ? 'Writer' : 'Assistant'}: ${turn.content.trim()}`)
		.join('\n\n');
	return [
		previous
			? 'Below is a summary of the start of a conversation between a writer and their writing Assistant, followed by the next part of it. Rewrite the summary so it covers both.'
			: 'Below is the start of a conversation between a writer and their writing Assistant. Summarise it.',
		'Keep what the rest of the conversation may depend on: decisions the writer made, facts they settled about the story or world, questions or requests still open, and how they asked to be helped. Leave out small talk and anything already resolved and no longer relevant.',
		'Reply with only the summary, as short plain paragraphs or a short list, with no preamble or heading. Stay under 300 words.',
		'Write in the same language as the conversation.',
		...(previous ? ['', '--- Summary so far', previous.trim()] : []),
		'',
		'--- Conversation',
		transcript
	].join('\n');
}

export function chatSummarySystemMessage(summary: string): ChatMessage {
	return {
		role: 'system',
		content: `The start of this conversation no longer fits, so here is a summary of it. The turns after it are verbatim.\n\n${summary}`
	};
}
