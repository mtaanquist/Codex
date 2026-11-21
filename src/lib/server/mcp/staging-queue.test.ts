import { describe, expect, it } from 'vitest';
import { inStagingTurn, StagingBusyError } from './staging-queue';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('inStagingTurn', () => {
	it('runs calls with one key one at a time, in the order they came', async () => {
		const log: string[] = [];
		const work = (name: string, ms: number) => async () => {
			log.push(`${name} in`);
			await pause(ms);
			log.push(`${name} out`);
			return name;
		};
		const results = await Promise.all([
			inStagingTurn('a', 5, work('one', 20)),
			inStagingTurn('a', 5, work('two', 1)),
			inStagingTurn('a', 5, work('three', 1))
		]);
		expect(results).toEqual(['one', 'two', 'three']);
		expect(log).toEqual(['one in', 'one out', 'two in', 'two out', 'three in', 'three out']);
	});

	it('does not hold one key back for another', async () => {
		const log: string[] = [];
		await Promise.all([
			inStagingTurn('a', 5, async () => {
				await pause(20);
				log.push('a');
			}),
			inStagingTurn('b', 5, async () => {
				log.push('b');
			})
		]);
		expect(log).toEqual(['b', 'a']);
	});

	it('turns away a call when the line is full, and takes calls again once it clears', async () => {
		const slow = () => pause(20);
		const calls = [1, 2, 3, 4].map(() => inStagingTurn('a', 2, slow));
		const outcomes = await Promise.allSettled(calls);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'rejected'
		]);
		expect((outcomes[3] as PromiseRejectedResult).reason).toBeInstanceOf(StagingBusyError);
		await expect(inStagingTurn('a', 0, async () => 'again')).resolves.toBe('again');
	});

	it('lets the next call run after one that failed', async () => {
		const failing = inStagingTurn('a', 5, async () => {
			throw new Error('no');
		});
		const next = inStagingTurn('a', 5, async () => 'next');
		await expect(failing).rejects.toThrow('no');
		await expect(next).resolves.toBe('next');
	});
});
