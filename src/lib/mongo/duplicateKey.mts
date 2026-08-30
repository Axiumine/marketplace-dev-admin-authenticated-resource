/**
 * Whether a driver error is a unique-index violation.
 *
 * MongoDB answers 11000 for a duplicate key on both an insert and an update. Without this test the
 * error travels through `tryCatchRethrow`, which reports it to Sentry and answers a generic 500 — so an
 * admin who retyped an email another shopOwner already owns is told the server broke, and the
 * platform gets an alert for a routine data-entry collision.
 *
 * The check is duck-typed rather than `instanceof MongoServerError`: mongoose re-exports the driver's
 * error classes but does not guarantee that the instance a model method rejects with comes from the
 * same copy of `mongodb` the service resolves — a second copy under a transitive dependency makes the
 * `instanceof` false while `code` is still 11000.
 */
export const duplicateKey = (e: unknown): boolean =>
	typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 11000
