// Database error classification. Import-free (like queues.ts) so modules the
// worker uses can import it; db/index.ts reads $env and cannot be.

/** Whether a thrown database error is a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
	return (err as { cause?: { code?: string } })?.cause?.code === '23505';
}
