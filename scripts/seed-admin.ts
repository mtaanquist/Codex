import pg from 'pg';
import { hash } from '@node-rs/argon2';

// Seeds the first admin user, pre-verified and pre-approved.
// Usage: npm run seed:admin -- <email> <password> <display name>
const [email, password, displayName] = process.argv.slice(2);
if (!email || !password || !displayName) {
	console.error('Usage: npm run seed:admin -- <email> <password> <display name>');
	process.exit(1);
}

const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

const client = new pg.Client({ connectionString });
await client.connect();
try {
	await client.query(
		`insert into users (email, display_name, password_hash, role, email_verified_at, approved_at)
		 values ($1, $2, $3, 'admin', now(), now())`,
		[email.trim().toLowerCase(), displayName, passwordHash]
	);
	console.log(`Admin user ${email} created.`);
} finally {
	await client.end();
}
