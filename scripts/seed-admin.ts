import { createInterface } from 'node:readline';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/lib/server/db/schema';
import { createFirstAdmin } from '../src/lib/server/admin';

// Seeds the first site admin, pre-verified and pre-approved. A one-shot
// bootstrap: once an admin exists it refuses (manage further admins in the
// app). Run it against the running stack, for example:
//   docker compose exec -it app node scripts/seed-admin.ts admin@example.com "Admin Name"
// The password comes from a hidden prompt, or from ADMIN_PASSWORD for
// unattended provisioning, so it never lands in the shell history or argv.
const [email, displayName] = process.argv.slice(2);
if (!email || !displayName) {
	console.error('Usage: node scripts/seed-admin.ts <email> "<display name>"');
	process.exit(1);
}

const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('Password: '));
if (!password) {
	console.error('A password is required.');
	process.exit(1);
}

const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';
const pool = new pg.Pool({ connectionString });
const db = drizzle(pool, { schema });

const result = await createFirstAdmin(db, { email, password, displayName });
await pool.end();

if (!result.ok) {
	console.error(result.reason);
	process.exit(1);
}
console.log(`Admin user ${email.trim().toLowerCase()} created.`);

// Reads a line from stdin without echoing the typed characters, so the
// password stays off the screen. The prompt itself is written once; every
// later redraw (the keystroke echo) is suppressed.
function promptHidden(query: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const iface = rl as unknown as {
			_writeToOutput: (text: string) => void;
			output: NodeJS.WriteStream;
		};
		let promptShown = false;
		iface._writeToOutput = (text) => {
			if (!promptShown) {
				iface.output.write(text);
				promptShown = true;
			}
		};
		rl.question(query, (answer) => {
			rl.close();
			process.stdout.write('\n');
			resolve(answer);
		});
	});
}
