import { describe, it, expect } from 'vitest';
import { backupConfig, backupKey, backupKeyTime, selectPrunable } from './backups.ts';

describe('backupConfig', () => {
	it('is off until the bucket and keys are set', () => {
		expect(backupConfig({})).toBeNull();
		expect(backupConfig({ BACKUP_S3_BUCKET: 'b' })).toBeNull();
	});

	it('applies defaults and trims the prefix', () => {
		const config = backupConfig({
			BACKUP_S3_BUCKET: 'codex',
			BACKUP_S3_ACCESS_KEY_ID: 'id',
			BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
			BACKUP_S3_PREFIX: 'mine///'
		});
		expect(config).toMatchObject({
			bucket: 'codex',
			prefix: 'mine',
			region: 'auto',
			keepRecentHours: 48,
			keepDays: 30,
			cron: '0 * * * *',
			endpoint: undefined
		});
	});

	it('rejects nonsense retention values', () => {
		const config = backupConfig({
			BACKUP_S3_BUCKET: 'codex',
			BACKUP_S3_ACCESS_KEY_ID: 'id',
			BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
			BACKUP_KEEP_RECENT_HOURS: '-4',
			BACKUP_KEEP_DAYS: 'soon'
		});
		expect(config).toMatchObject({ keepRecentHours: 48, keepDays: 30 });
	});
});

describe('backupKey and backupKeyTime', () => {
	it('round-trips the timestamp through the key name', () => {
		const when = new Date('2026-06-04T03:15:42.123Z');
		const key = backupKey('p', when);
		expect(key).toBe('p/codex-2026-06-04T03-15-42-123Z.dump');
		expect(backupKeyTime(key)?.toISOString()).toBe(when.toISOString());
	});

	it('produces keys that sort lexically by age', () => {
		const older = backupKey('p', new Date('2026-06-04T03:00:00Z'));
		const newer = backupKey('p', new Date('2026-06-05T03:00:00Z'));
		expect(older < newer).toBe(true);
	});

	it('returns null for foreign keys', () => {
		expect(backupKeyTime('p/notes.txt')).toBeNull();
	});
});

describe('selectPrunable', () => {
	const now = new Date('2026-06-04T12:00:00Z');
	const key = (iso: string) => backupKey('p', new Date(iso));

	it('keeps everything inside the recent window', () => {
		const keys = [key('2026-06-04T11:00:00Z'), key('2026-06-03T13:00:00Z')];
		expect(selectPrunable(keys, now, 48, 30)).toEqual([]);
	});

	it('keeps only the newest per day beyond the window', () => {
		const morning = key('2026-05-20T08:00:00Z');
		const evening = key('2026-05-20T20:00:00Z');
		const other = key('2026-05-21T09:00:00Z');
		expect(selectPrunable([morning, evening, other], now, 48, 30)).toEqual([morning]);
	});

	it('prunes everything older than keepDays', () => {
		const ancient = key('2026-01-01T03:00:00Z');
		expect(selectPrunable([ancient], now, 48, 30)).toEqual([ancient]);
	});

	it('never deletes keys it cannot parse', () => {
		expect(selectPrunable(['p/manual-snapshot.dump'], now, 48, 30)).toEqual([]);
	});
});
