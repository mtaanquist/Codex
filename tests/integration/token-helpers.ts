import { armToken } from '../../src/lib/server/tokens';
import type { Database } from '../../src/lib/server/auth';

// Arms a reserved token the way the email worker does, returning the raw value
// the emailed link would carry.
export async function sentToken(db: Database, tokenId: string): Promise<string> {
	const armed = await armToken(db, tokenId);
	if (!armed.ok) throw new Error(`token could not be armed: ${armed.reason}`);
	return armed.token;
}
