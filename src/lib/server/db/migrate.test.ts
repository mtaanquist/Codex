import { describe, expect, it } from 'vitest';
import { outOfOrderMigrations, readJournal } from './migrate';

describe('outOfOrderMigrations', () => {
	it('finds nothing wrong with the committed journal', () => {
		expect(outOfOrderMigrations(readJournal('drizzle'))).toEqual([]);
	});

	it('flags an entry that does not sort after the one before it', () => {
		expect(
			outOfOrderMigrations([
				{ tag: '0000_a', when: 100 },
				{ tag: '0001_b', when: 300 },
				{ tag: '0002_c', when: 200 },
				{ tag: '0003_d', when: 200 }
			])
		).toEqual(['0002_c', '0003_d']);
	});
});
