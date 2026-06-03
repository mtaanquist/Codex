import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../lib/server/db/schema.ts';
import { rebuildSceneMentions, rebuildUniverseMentions } from '../lib/server/mentions.ts';

// Background job processor. Runs directly under Node's native TypeScript
// support, so there is no build step; relative imports carry .ts extensions.
const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

const db = drizzle(new pg.Pool({ connectionString }), { schema });
const boss = new PgBoss(connectionString);

boss.on('error', (error) => {
	console.error('pg-boss error:', error);
});

await boss.start();
await boss.createQueue('mentions-scene');
await boss.createQueue('mentions-universe');

await boss.work<{ sceneId: string }>('mentions-scene', async (jobs) => {
	for (const job of jobs) {
		const result = await rebuildSceneMentions(db, job.data.sceneId);
		if (result.ok) console.log(`mentions: scene ${job.data.sceneId} -> ${result.count}`);
		else console.warn(`mentions: scene ${job.data.sceneId} skipped (${result.reason})`);
	}
});

await boss.work<{ universeId: string }>('mentions-universe', async (jobs) => {
	for (const job of jobs) {
		const count = await rebuildUniverseMentions(db, job.data.universeId);
		console.log(`mentions: universe ${job.data.universeId} -> ${count} scenes reindexed`);
	}
});

console.log('Worker started; processing mention rebuilds.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void boss.stop().then(() => process.exit(0));
	});
}
