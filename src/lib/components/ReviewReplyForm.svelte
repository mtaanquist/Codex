<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionResult } from '@sveltejs/kit';
	import Icon from './Icon.svelte';

	// The reply row shared by the comment and suggestion cards: the text field,
	// the "Assistant is replying..." note, and the post-submit trigger that asks
	// the Assistant to answer in its own threads. The cards differ only in the
	// action, the hidden id field, and how the thread id comes back.
	let {
		action,
		fieldName,
		fieldValue,
		assistant = null,
		assistantAnswers = false,
		threadIdFromResult,
		onAssistantReply = null
	}: {
		// The form action, e.g. "?/reply" or "?/replySuggestion".
		action: string;
		// The hidden id the action needs ("threadId" or "suggestionId").
		fieldName: string;
		fieldValue: string;
		// Set when the Assistant answers here; carries its name for the note.
		assistant?: { name: string } | null;
		// Whether a successful reply should trigger the Assistant's turn.
		assistantAnswers?: boolean;
		// The thread id to answer in, read from the reply result, or null to skip.
		threadIdFromResult: (result: ActionResult) => string | null;
		onAssistantReply?: ((threadId: string) => Promise<void>) | null;
	} = $props();

	let replyText = $state('');
	let assistantBusy = $state(false);

	async function triggerAssistant(threadId: string) {
		if (!onAssistantReply || assistantBusy) return;
		assistantBusy = true;
		try {
			await onAssistantReply(threadId);
		} finally {
			assistantBusy = false;
		}
	}
</script>

{#if assistantBusy && assistant}
	<div class="rv-assistant-wait">
		<Icon name="sparkles" size={12} />
		{assistant.name} is replying...
	</div>
{/if}
<form
	method="POST"
	{action}
	class="rv-reply"
	use:enhance={() =>
		async ({ result, update }) => {
			replyText = '';
			await update({ reset: false });
			const threadId = threadIdFromResult(result);
			if (assistantAnswers && threadId) void triggerAssistant(threadId);
		}}
>
	<input type="hidden" name={fieldName} value={fieldValue} />
	<input
		type="text"
		name="body"
		placeholder="Reply..."
		aria-label="Reply"
		bind:value={replyText}
		required
	/>
	<button class="rv-reply-send" type="submit" disabled={!replyText.trim()} aria-label="Send reply">
		<Icon name="reply" size={15} />
	</button>
</form>
