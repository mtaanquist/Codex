import { describe, it, expect, vi, afterEach } from 'vitest';

const goto = vi.fn();
vi.mock('$app/navigation', () => ({ goto }));

const { openHref } = await import('./open-href');

describe('openHref', () => {
	afterEach(() => {
		goto.mockReset();
		vi.unstubAllGlobals();
	});

	it('navigates in the app to a page', async () => {
		const assign = vi.fn();
		vi.stubGlobal('location', { assign });
		goto.mockResolvedValue(undefined);
		await openHref('/stories/s/review');
		expect(goto).toHaveBeenCalledWith('/stories/s/review');
		expect(assign).not.toHaveBeenCalled();
	});

	it('loads an address that is not a page, such as an export download', async () => {
		const assign = vi.fn();
		vi.stubGlobal('location', { assign });
		goto.mockRejectedValue(new Error('navigation_route_missing'));
		await openHref('/exports/abc');
		expect(assign).toHaveBeenCalledWith('/exports/abc');
	});
});
