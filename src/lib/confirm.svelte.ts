import type { SubmitFunction } from '@sveltejs/kit';

// The app's own confirm prompt, in place of the browser's confirm(). One
// ConfirmDialog in the root layout shows whatever is asked here.
export type ConfirmOptions = {
	title: string;
	body?: string;
	// The verb on the button that goes ahead ("Delete scene"), never "OK".
	confirmLabel: string;
	// A destructive action: a red button, and Cancel takes the focus.
	danger?: boolean;
};

type Pending = ConfirmOptions & { answer: (ok: boolean) => void };

export const confirmPrompt = $state<{ pending: Pending | null }>({ pending: null });

export function askConfirm(options: ConfirmOptions): Promise<boolean> {
	// A second question replaces an unanswered first one, which counts as Cancel.
	confirmPrompt.pending?.answer(false);
	return new Promise((resolve) => {
		confirmPrompt.pending = { ...options, answer: resolve };
	});
}

export function answerConfirm(ok: boolean) {
	const pending = confirmPrompt.pending;
	confirmPrompt.pending = null;
	pending?.answer(ok);
}

// Forms that were confirmed and are being submitted again.
const confirmed = new WeakSet<HTMLFormElement>();

// An onsubmit handler for a plain (not enhanced) form: holds the submit, asks,
// and submits again with the same button if the answer is yes.
export function confirmSubmit(options: ConfirmOptions) {
	return async (event: SubmitEvent) => {
		const form = event.target as HTMLFormElement;
		if (confirmed.has(form)) {
			confirmed.delete(form);
			return;
		}
		event.preventDefault();
		const submitter = event.submitter as HTMLButtonElement | null;
		if (!(await askConfirm(options))) return;
		confirmed.add(form);
		form.requestSubmit(submitter);
	};
}

// The same for a form with use:enhance, whose submit cannot be held from
// onsubmit: pass this as the enhance callback.
export function confirmEnhance(options: ConfirmOptions): SubmitFunction {
	return async ({ cancel }) => {
		if (!(await askConfirm(options))) cancel();
	};
}
