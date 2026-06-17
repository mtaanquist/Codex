<script lang="ts">
	import { enhance } from '$app/forms';
	import { autosaveSubmit, autosubmitForm } from '$lib/autosave-form';
	import { ADMIN_KINDS, NOTIFICATION_KINDS, NOTIFICATION_LABELS } from '$lib/notifications';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Only admins approve accounts, so only they see that notification row.
	const visibleKinds = $derived(
		NOTIFICATION_KINDS.filter((kind) => data.user?.isAdmin || !ADMIN_KINDS.includes(kind))
	);
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Notifications</h1>
	<p class="admin-lede">
		What reaches you, and where: the bell in the top bar, email, both, or neither. Emails arrive
		batched, so a busy hour sends one message.
	</p>
</div>

<div class="admin-block">
	<div class="settings-group">
		<form
			method="POST"
			action="?/saveNotifications"
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<table class="notify-grid">
				<thead>
					<tr>
						<th></th>
						<th scope="col">In app</th>
						<th scope="col">Email</th>
					</tr>
				</thead>
				<tbody>
					{#each visibleKinds as kind (kind)}
						<tr>
							<th scope="row">{NOTIFICATION_LABELS[kind]}</th>
							<td>
								<input
									type="checkbox"
									name="inapp_{kind}"
									checked={data.preferences.notifications[kind].inApp}
									aria-label="{NOTIFICATION_LABELS[kind]} in app"
								/>
							</td>
							<td>
								<input
									type="checkbox"
									name="email_{kind}"
									checked={data.preferences.notifications[kind].email}
									aria-label="{NOTIFICATION_LABELS[kind]} by email"
								/>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<div class="settings-actions">
				<FormStatus success={form?.scope === 'notifyprefs' && form.saved ? 'Saved.' : null} />
			</div>
		</form>
	</div>
</div>
