<script lang="ts">
	import FormStatus from '$lib/components/FormStatus.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Codes count against the allowance while they exist, so revoking an
	// unused one frees its slot.
	const remaining = $derived(Math.max(0, data.inviteAllowance - data.myInvites.length));

	function codeStatus(code: PageData['myInvites'][number]): string {
		return code.usedCount >= code.maxUses ? 'Used' : 'Not used yet';
	}

	// Briefly marks a row after its sign-up link is copied.
	let copiedId = $state<string | null>(null);
	function copyLink(code: PageData['myInvites'][number]) {
		const link = `${data.origin}/signup?code=${encodeURIComponent(code.code)}`;
		navigator.clipboard.writeText(link).then(() => {
			copiedId = code.id;
			setTimeout(() => {
				if (copiedId === code.id) copiedId = null;
			}, 1500);
		});
	}
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Invites</h1>
	<p class="admin-lede">Invite codes you can share with friends so they can join this Codex.</p>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Invite a friend</h2>
		<p class="admin-block-sub">
			Generate a code and send your friend its sign-up link. Each code admits one person, who can
			sign in as soon as their email is confirmed. You have {remaining}
			{remaining === 1 ? 'invite' : 'invites'} left.
		</p>
	</div>

	<form method="POST" action="?/createInvite">
		<div class="settings-actions" style="justify-content:flex-start;">
			<button type="submit" class="btn btn-primary" disabled={remaining === 0}>
				Generate an invite
			</button>
			<FormStatus
				error={form?.scope === 'invites' && form.message ? form.message : null}
				success={form?.scope === 'invites' && form.saved ? 'Done.' : null}
			/>
		</div>
	</form>

	{#if data.myInvites.length > 0}
		<div class="admin-card tight" style="margin-top:var(--space-4);">
			<div class="attn-list">
				{#each data.myInvites as code (code.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title" style="font-family:var(--font-mono);">{code.code}</div>
							<div class="list-sub">{codeStatus(code)}</div>
						</div>
						<button type="button" class="btn btn-ghost btn-sm" onclick={() => copyLink(code)}>
							{copiedId === code.id ? 'Copied' : 'Copy link'}
						</button>
						{#if code.usedCount === 0}
							<form method="POST" action="?/deleteInvite">
								<input type="hidden" name="inviteId" value={code.id} />
								<button type="submit" class="btn btn-ghost btn-sm">Revoke</button>
							</form>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
