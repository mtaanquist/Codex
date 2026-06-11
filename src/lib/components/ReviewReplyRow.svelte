<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import ReviewAvatar from './ReviewAvatar.svelte';
	import { formatDateTime } from '$lib/format';

	// One reply in a card's discussion list, shared by the comment and
	// suggestion cards. retractAction names the form action for deleting your
	// own reply; null hides the control.
	let {
		reply,
		retractAction = null,
		onConfirmRetract = () => {}
	}: {
		reply: {
			id: string;
			authorName: string;
			isOwner: boolean;
			isAssistant: boolean;
			mine: boolean;
			body: string;
			createdAt: Date | string;
		};
		retractAction?: string | null;
		onConfirmRetract?: (e: SubmitEvent) => void;
	} = $props();
</script>

<div class="rv-reply-row">
	<ReviewAvatar
		author={{ isOwner: reply.isOwner, isAssistant: reply.isAssistant, name: reply.authorName }}
		size={20}
	/>
	<div class="rv-reply-main">
		<div class="rv-reply-head">
			<span class="rv-reply-name">{reply.authorName}</span>
			<span class="rv-reply-when">{formatDateTime(reply.createdAt)}</span>
			{#if reply.mine && retractAction}
				<form
					method="POST"
					action={retractAction}
					class="rv-reply-del"
					use:enhance
					onsubmit={onConfirmRetract}
				>
					<input type="hidden" name="commentId" value={reply.id} />
					<button type="submit" title="Delete your reply" aria-label="Delete your reply">
						<Icon name="trash" size={12} />
					</button>
				</form>
			{/if}
		</div>
		<div class="rv-reply-body">{reply.body}</div>
	</div>
</div>
