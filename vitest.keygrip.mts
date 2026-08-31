import { randomBytes } from 'node:crypto'

import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { wrapKeygripKeys } from '@axiumine/marketplace-common/encryption/wrapKeygripKeys'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'

/**
 * The keyspace the integration project runs in.
 *
 * Declared here rather than inline in `vitest.config.mts` because `globalSetup` has to write the
 * keygrip record into the *same* namespace the service under test will read it from, and those two
 * run in different processes — the project's `env` block never reaches this one. One constant, two
 * readers, no chance of seeding a prefix nobody looks at.
 */
export const ITEST_REDIS_KEY = 'marketplaceDev:itest:adminAuthenticatedResource:'

/**
 * The key set the integration run starts from.
 *
 * Two entries, not one: this is the service that *rotates*, and a rotation of a single-key set proves
 * nothing about the property that matters — that the keys still verifying customers' cookies survive
 * the write, in order, behind the new one. Both are old enough to be inert as credentials and visibly
 * not minted by anybody (`Buffer.alloc`), and neither is old enough to be retired, so the first
 * rotation of a run always answers three keys.
 *
 * The ids carry the `k<n>` shape the seed script mints rather than a test-only one, so the id a rotation
 * derives from them is the id it would derive in production — `k3`, then `k4`.
 */
export const ITEST_KEYGRIP_KEYS = [
	{ id: 'k2', material: Buffer.alloc(64, 42).toString('base64'), createdAt: '2026-08-11T00:00:00.000Z' },
	{ id: 'k1', material: Buffer.alloc(64, 24).toString('base64'), createdAt: '2026-08-01T00:00:00.000Z' }
]

/**
 * Mint a throwaway KEK and a keygrip record for the integration run (ADR-034).
 *
 * ⚠️ **Nothing boots without this.** `KEYGRIP_KEK` is in this service's `REQUIRED_ENV_VARS`: it holds
 * the key that opens the record because `keygripRotate` is where the platform's signing keys are
 * minted, so an integration suite that only sets env starts a service that refuses to start, correctly.
 * Seeding is therefore part of provisioning the run, next to the throwaway database and the throwaway
 * CSFLE key, and for the same reason: the suite owns its secrets and destroys them with the run.
 *
 * ⚠️ **The KEK is minted here and exported through `process.env`.** vitest forks its workers after
 * `globalSetup` returns, so they inherit it — the same mechanism `SEED_DEMO` already relies on. It is
 * never read from the developer's environment file: a test run must not be able to touch, or be
 * confused by, the key the real services use. Random every run, unlike the keys it wraps: nothing needs
 * to predict it, so nothing should be able to.
 *
 * ⚠️ **The record is deleted first.** A run that rotated left version 2 behind, and a fresh seed writing
 * version 1 over it would leave `HSET` fields from neither — `DEL` then write is the only way to know
 * the three fields all came from this run.
 */
export async function seedKeygrip(): Promise<void> {
	const kek = randomBytes(32)
	process.env.KEYGRIP_KEK = kek.toString('base64')

	await RedisConnect()
	try {
		await redisClient.del(`${ITEST_REDIS_KEY}keygrip`)
		await redisClient.hSet(`${ITEST_REDIS_KEY}keygrip`, {
			version: '1',
			wrapped: wrapKeygripKeys(ITEST_KEYGRIP_KEYS, 1, kek),
			fp: keygripFingerprint(ITEST_KEYGRIP_KEYS)
		})
	} finally {
		// This process only provisions; every test file opens its own client.
		await redisClient.close().catch(() => undefined)
	}
}
