import { PgBoss } from 'pg-boss';

// Near-empty pg-boss process; real jobs arrive in later phases. Runs directly
// under Node 24's native TypeScript support, so there is no build step.
const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

const boss = new PgBoss(connectionString);

boss.on('error', (error) => {
	console.error('pg-boss error:', error);
});

await boss.start();
console.log('Worker started; no jobs registered yet.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void boss.stop().then(() => process.exit(0));
	});
}
