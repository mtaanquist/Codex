import { describe, it, expect } from 'vitest';
import { backupConfig, backupKey, selectPrunable } from './backups.ts';

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
			keep: 30,
			cron: '0 3 * * *',
			endpoint: undefined
		});
	});

	it('rejects a nonsense retention count', () => {
		const config = backupConfig({
			BACKUP_S3_BUCKET: 'codex',
			BACKUP_S3_ACCESS_KEY_ID: 'id',
			BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
			BACKUP_KEEP: '-4'
		});
		expect(config?.keep).toBe(30);
	});
});

describe('backupKey', () => {
	it('produces keys that sort lexically by age', () => {
		const older = backupKey('p', new Date('2026-06-04T03:00:00Z'));
		const newer = backupKey('p', new Date('2026-06-05T03:00:00Z'));
		expect(older < newer).toBe(true);
		expect(older).toMatch(/^p\/codex-2026-06-04T03-00-00-000Z\.dump$/);
	});
});

describe('selectPrunable', () => {
	const keys = ['p/codex-2026-06-01.dump', 'p/codex-2026-06-03.dump', 'p/codex-2026-06-02.dump'];

	it('keeps the newest n and prunes the rest, oldest included', () => {
		expect(selectPrunable(keys, 2)).toEqual(['p/codex-2026-06-01.dump']);
		expect(selectPrunable(keys, 3)).toEqual([]);
	});

	it('never prunes everything', () => {
		expect(selectPrunable(keys, 0)).toHaveLength(2);
	});
});
