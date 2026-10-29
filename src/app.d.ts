// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { SessionUser } from '$lib/server/auth';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: SessionUser | null;
			session: { id: string; expiresAt: Date } | null;
		}
		interface PageData {
			// The author's timezone, from the root layout; pass it to the date
			// helpers in $lib/format.
			timeZone: string;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
