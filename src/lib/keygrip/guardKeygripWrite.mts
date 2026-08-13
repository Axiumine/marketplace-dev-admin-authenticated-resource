import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { assertUnderRateLimit } from '@axiumine/marketplace-common/others/assertUnderRateLimit'

/** One hour, in seconds — the window a keygrip write is metered over. */
export const KEYGRIP_WRITE_WINDOW_SECONDS = 3600

/**
 * Keygrip writes one operator may make per hour, per operation.
 *
 * Rotation is a monthly job and retirement is an incident response, so ten is far above any honest use and
 * still low enough to stop a runaway client: every write reseals the record and publishes a version bump
 * that six processes act on, and a loop hammering the button would walk the key set to its cap — at which
 * point rotation refuses until the oldest key ages out, and nobody can rotate for days.
 */
export const KEYGRIP_WRITES_PER_HOUR = 10

/**
 * Meters one operator's keygrip writes (E16-S07).
 *
 * ⚠️ **The identity is the operator's account id, never a network address.** `app.proxy` is off on every
 * service here, so the address this process reports is nginx's own and a counter kept against it would be
 * one global bucket the whole platform spends — the per-address half of rate limiting is the edge's, keyed
 * on `$binary_remote_addr` in `conf.d/20-rate-limit.conf`. What an admin id meters is what this layer can
 * actually see, and `assertUnderRateLimit` hashes it into the key so the counters do not become a list of
 * which operators touched the signing keys.
 *
 * ⚠️ **A bucket per operation, not one shared budget.** Retiring a key is what an operator does *during*
 * a suspected compromise, and a shared counter would let an afternoon of rotations spend the allowance for
 * the one write that has to go through.
 */
export async function guardKeygripWrite(operation: string, operator: string) {
	await assertUnderRateLimit(
		redisClient,
		`keygrip:${operation}`,
		operator,
		KEYGRIP_WRITES_PER_HOUR,
		KEYGRIP_WRITE_WINDOW_SECONDS
	)
}
