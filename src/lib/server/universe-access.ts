import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { universes } from './db/schema';

// Loads a universe, 404ing unless the user owns it. Shared by the universe
// routes.
export async function ownedUniverse(universeId: string, userId: string) {
	const [universe] = await db
		.select()
		.from(universes)
		.where(and(eq(universes.id, universeId), eq(universes.ownerId, userId)));
	if (!universe) error(404, 'Universe not found');
	return universe;
}
