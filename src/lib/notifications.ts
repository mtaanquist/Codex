// The notification kinds and their account-page labels, shared by the
// preference matrix, the bell, and the server fan-out.

export const NOTIFICATION_KINDS = ['review_activity', 'review_reply', 'account_pending'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
	review_activity: 'Review activity on your stories',
	review_reply: 'Replies to your review comments',
	account_pending: 'New accounts awaiting approval'
};

// Only admins approve accounts, so only they see that row.
export const ADMIN_KINDS: NotificationKind[] = ['account_pending'];

export type NotificationChannels = { inApp: boolean; email: boolean };
export type NotificationMatrix = Record<NotificationKind, NotificationChannels>;

export const DEFAULT_CHANNELS: NotificationChannels = { inApp: true, email: true };

// What a notification carries for display and navigation. href is absent
// when there is nowhere to send the reader (a guest reviewer's thread is
// only reachable through their review link).
export type NotificationPayload = { title: string; detail?: string; href?: string };

// The bell's wire shape.
export type NotificationItem = {
	id: string;
	kind: NotificationKind;
	title: string;
	detail: string | null;
	href: string | null;
	read: boolean;
	createdAt: string;
};

// A comment body cut down to a one-line teaser for the bell, the digest
// emails, and anywhere else a snippet stands in for the full text. One
// helper, one length, so the same comment never truncates differently in
// two surfaces.
const TEASER_MAX = 120;
export function teaser(body: string, max = TEASER_MAX): string {
	const line = body.replace(/\s+/g, ' ').trim();
	return line.length > max ? `${line.slice(0, max)}...` : line;
}
