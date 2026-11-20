import { describe, expect, it } from 'vitest';
import { layerModels } from './config';

describe('layerModels', () => {
	it('takes the most specific choice for each role', () => {
		expect(
			layerModels(
				{ chat: 'account-chat', utility: 'account-utility', reviewer: 'account-reviewer' },
				{ utility: 'universe-utility', reviewer: 'universe-reviewer' },
				{ reviewer: 'story-reviewer' }
			)
		).toEqual({ chat: 'account-chat', utility: 'universe-utility', reviewer: 'story-reviewer' });
	});

	it('falls back one level when a level picks nothing', () => {
		expect(layerModels({ chat: 'a' }, {}, {})).toEqual({ chat: 'a' });
		expect(layerModels({ chat: 'a' }, { chat: 'u' }, {})).toEqual({ chat: 'u' });
	});
});
