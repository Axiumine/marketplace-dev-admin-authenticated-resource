import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { assertUnderRateLimit } from '@axiumine/marketplace-common/others/assertUnderRateLimit'

/** One hour, in seconds — the window an admin's session revocations are metered over. */
export const SESSION_WRITE_WINDOW_SECONDS = 3600

/**
 * Session revocations one admin may make per hour, per operation.
 *
 * Sixty, an order of magnitude above the keygrip figure and for the opposite reason: ending sessions is the
 * routine half of an incident — an admin working through a list of compromised accounts issues one call
 * per account — while rotating the platform's signing keys is a monthly job. The cap is here to stop a
 * runaway client, not to ration the admin's judgement.
 *
 * ⚠️ **A revocation that is refused must read as refused.** `assertUnderRateLimit` throws a 429, which the
 * console shows as a failure; the failure mode this number exists to prevent is a loop that silently ends
 * every session on the platform, not an admin who has to wait.
 */
export const SESSION_WRITES_PER_HOUR = 60

/**
 * Meters one admin's session revocations (E17-S03).
 *
 * ⚠️ **The identity is the admin's account id, never a network address** (BCON-01). `app.proxy` is off
 * on every service here, so the address this process reports is nginx's own and a counter kept against it
 * would be one global bucket the whole platform spends — the per-address half of rate limiting is the
 * edge's, keyed on `$binary_remote_addr` in `conf.d/20-rate-limit.conf`. `assertUnderRateLimit` hashes the
 * id into the key, so the counters do not become a list of which admins ended whose sessions.
 *
 * ⚠️ **A bucket per operation, exactly as `guardKeygripWrite` does it.** "Revoke this session" and "revoke
 * everything this account holds" are answers to different questions, and an afternoon spent on the first
 * must not spend the allowance for the second.
 */
export async function guardSessionWrite(operation: string, admin: string) {
	await assertUnderRateLimit(redisClient, `session:${operation}`, admin, SESSION_WRITES_PER_HOUR, SESSION_WRITE_WINDOW_SECONDS)
}
