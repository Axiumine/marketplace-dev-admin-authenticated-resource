import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { assertUnderRateLimit } from '@axiumine/marketplace-common/others/assertUnderRateLimit'

/** One hour, in seconds — the window an admin's own-password re-authentication is metered over. */
export const ADMIN_UPDATE_PWD_WRITE_WINDOW_SECONDS = 3600

/**
 * Old-password guesses one admin may make per hour.
 *
 * Five: tight on purpose, unlike `guardSessionWrite`'s sixty or `guardKeygripWrite`'s ten. Those two meter
 * routine admin work; this meters the platform's only defense against a stolen admin bearer token being
 * upgraded into a permanent password change — `compareHashAsync(passwordOld, …)` in `funAdminUpdatePwd`,
 * partially blunted today only by a coarse per-IP nginx ceiling. An admin who mistypes their current
 * password five times in an hour can simply try again next hour; an attacker spending a stolen token
 * cannot spend it faster than that.
 */
export const ADMIN_UPDATE_PWD_ATTEMPTS_PER_HOUR = 5

/**
 * Meters one admin's own-password re-authentication attempts.
 *
 * ⚠️ **The identity is the admin's own account id, never a network address**, for the same reason
 * `guardKeygripWrite`/`guardSessionWrite` are keyed that way: `app.proxy` is off on every service here, so
 * the address this process reports is nginx's own, and a counter kept against it would be one global
 * bucket the whole platform spends. `assertUnderRateLimit` hashes the id into the key, so the counters do
 * not become a list of which admins got their own password wrong.
 *
 * A single bucket, unlike the other two guards' per-operation ones: `funAdminUpdatePwd` is the one write on
 * this tier that re-authenticates against a password, so there is nothing else to keep it separate from.
 */
export async function guardAdminUpdatePwdWrite(admin: string) {
	await assertUnderRateLimit(
		redisClient,
		'admin:updatePwd',
		admin,
		ADMIN_UPDATE_PWD_ATTEMPTS_PER_HOUR,
		ADMIN_UPDATE_PWD_WRITE_WINDOW_SECONDS
	)
}
