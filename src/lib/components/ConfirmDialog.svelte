<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { modal } from '#lib/modal';
	import { answerConfirm, confirmPrompt } from '#lib/confirm.svelte';

	// The one confirm prompt (see #lib/confirm.svelte.ts), mounted once in the
	// root layout.
	const pending = $derived(confirmPrompt.pending);
	// The question belongs to the page it was asked on.
	beforeNavigate(() => answerConfirm(false));
</script>

{#if pending}
	<!-- No backdrop click: the prompt needs an answer, and a double click on the
	     button that opened it must not land on the backdrop as Cancel. -->
	<div class="modal-backdrop" data-over-menus>
		<div
			class="modal-panel"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="confirm-title"
			aria-describedby={pending.body ? 'confirm-body' : undefined}
			use:modal={{
				close: () => answerConfirm(false),
				initialFocus: pending.danger ? '.confirm-cancel' : '.confirm-ok'
			}}
		>
			<div class="modal-head">
				<div class="modal-head-main">
					<h2 class="modal-title" id="confirm-title">{pending.title}</h2>
				</div>
			</div>
			{#if pending.body}
				<div class="modal-body">
					<p class="confirm-body" id="confirm-body">{pending.body}</p>
				</div>
			{/if}
			<div class="modal-foot">
				<div class="modal-foot-note"></div>
				<button
					class="btn btn-sm btn-secondary confirm-cancel"
					type="button"
					onclick={() => answerConfirm(false)}
				>
					Cancel
				</button>
				<button
					class="btn btn-sm confirm-ok"
					class:btn-danger={pending.danger}
					class:btn-primary={!pending.danger}
					type="button"
					onclick={() => answerConfirm(true)}
				>
					{pending.confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.confirm-body {
		margin: 0;
	}
</style>
