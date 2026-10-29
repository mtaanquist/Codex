import { describe, it, expect, vi, beforeEach } from 'vitest';

type Callback = (opts: Record<string, unknown>) => Promise<void>;
let registered: ((input: unknown) => Promise<Callback>) | undefined;

vi.mock('$app/forms', () => ({
	enhance: (_form: unknown, submit: (input: unknown) => Promise<Callback>) => {
		registered = submit;
		return { destroy() {} };
	}
}));

const { enhance } = await import('./enhance');

async function submitWith(submit?: Parameters<typeof enhance>[1]) {
	enhance({} as HTMLFormElement, submit);
	const update = vi.fn(async () => {});
	const callback = await registered!({});
	await callback({ result: { type: 'success' }, update });
	return update;
}

describe('enhance', () => {
	beforeEach(() => {
		registered = undefined;
	});

	it('keeps a plain form on the current page', async () => {
		const update = await submitWith();
		expect(update).toHaveBeenCalledWith({ navigate: false });
	});

	it('keeps a callback form on the page and passes its options through', async () => {
		const update = await submitWith(() => async ({ update }) => {
			await update({ reset: false });
		});
		expect(update).toHaveBeenCalledWith({ navigate: false, reset: false });
	});

	it('lets a form opt back into navigating', async () => {
		const update = await submitWith(() => async ({ update }) => {
			await update({ navigate: true });
		});
		expect(update).toHaveBeenCalledWith({ navigate: true });
	});

	it('runs the default when the submit function returns nothing', async () => {
		const update = await submitWith(() => {});
		expect(update).toHaveBeenCalledWith({ navigate: false });
	});
});
