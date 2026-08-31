import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accessKeyOf, armSessionIndex, INDEXED_FIELDS, REDIS_KEY } from './sessionIndexMocks.mts'

const hKeys = vi.fn()
const hGet = vi.fn()
const del = vi.fn()
const hDel = vi.fn()

// Only the client is faked, as in `endEverySession.test.mts`: `revokeAllSessionsForAccount` runs for real,
// so what this suite reads is the Redis conversation itself rather than that a mock was called.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hKeys, hGet, del, hDel } }))

const { endEveryShopOwnerSession } = await import('../src/lib/auth/endEveryShopOwnerSession.mts')

const SHOP_OWNER_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
	armSessionIndex({ hKeys, hGet, del, hDel }, REDIS_KEY, INDEXED_FIELDS)
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('endEveryShopOwnerSession', () => {
	/*
	 * ⚠️ **`idx:shopOwner:`, and the tier is the whole safety of this call.** All nine services share one
	 * `REDIS_KEY` prefix and the tier is the only thing separating one account's index from another's, so
	 * `TIER.admin` here would read the index of an admin carrying the same `_id` — none exists, the
	 * revoke would delete nothing, and the mutation would report the shop owner locked out regardless.
	 */
	it('reads the shopOwner index of the account it was given', async () => {
		await endEveryShopOwnerSession(SHOP_OWNER_ID)

		// Twice: the second is the routine's re-read, and both keys are asserted so a re-read of another tier's
		// index could not pass as "at least one right key".
		expect(hKeys.mock.calls).toEqual([
			[`${REDIS_KEY}idx:shopOwner:${SHOP_OWNER_ID}`],
			[`${REDIS_KEY}idx:shopOwner:${SHOP_OWNER_ID}`]
		])
	})

	// The id arrives as an ObjectId from the resolver's argument and as a string from a test or a future
	// caller; both have to reach the same index key, so the interpolation is asserted rather than assumed.
	it('builds the same key from an ObjectId as from its string', async () => {
		await endEveryShopOwnerSession(new Types.ObjectId(SHOP_OWNER_ID))

		expect(hKeys.mock.calls.flat()).toEqual([
			`${REDIS_KEY}idx:shopOwner:${SHOP_OWNER_ID}`,
			`${REDIS_KEY}idx:shopOwner:${SHOP_OWNER_ID}`
		])
	})

	// One single-key `del` per key, both halves of every filed session, then the index key last — the
	// routine's own contract, read here through its first cross-account call site.
	it('deletes every filed session and the index last, one key per command', async () => {
		await endEveryShopOwnerSession(SHOP_OWNER_ID)

		expect(del.mock.calls).toEqual([
			...INDEXED_FIELDS.map((field) => [accessKeyOf(field)]),
			...INDEXED_FIELDS.map((field) => [`${REDIS_KEY}${field}`]),
			[`${REDIS_KEY}idx:shopOwner:${SHOP_OWNER_ID}`]
		])
	})

	/*
	 * ⚠️ **The access tokens go too, and the admin never sees one** (R54). This call site is the one that
	 * makes the mechanism worth having: an admin disabling a shop owner holds none of that account's
	 * tokens, so before the session hash was read for its `accessKey` there was no name for the access half
	 * at all and the account kept a working bearer token for up to 91 minutes after being disabled. Nothing
	 * beyond those two keys per session and the index is touched.
	 */
	it('deletes both halves of every session and nothing else', async () => {
		await endEveryShopOwnerSession(SHOP_OWNER_ID)

		expect(hGet.mock.calls).toEqual(INDEXED_FIELDS.map((field) => [`${REDIS_KEY}${field}`, 'accessKey']))
		expect(del).toHaveBeenCalledTimes(INDEXED_FIELDS.length * 2 + 1)
	})

	/*
	 * ⚠️ **The shop owner logging in while the admin disables them does not keep that session.**
	 * It is the likelier race of the two call sites: the account holder is at their keyboard and has no idea
	 * a write is landing. The re-read catches the newcomer, and the index key survives until it has been
	 * revoked — deleting it on the first round would leave that session live with nothing able to name it.
	 */
	it('revokes a session that appeared during the revoke, and keeps the index until it has', async () => {
		const NEWCOMER = 'c'.repeat(64)

		hKeys
			.mockResolvedValueOnce(INDEXED_FIELDS)
			.mockResolvedValueOnce([...INDEXED_FIELDS, NEWCOMER])
			.mockResolvedValueOnce([...INDEXED_FIELDS, NEWCOMER])

		await endEveryShopOwnerSession(SHOP_OWNER_ID)

		expect(del.mock.calls).toEqual([
			...INDEXED_FIELDS.map((field) => [accessKeyOf(field)]),
			...INDEXED_FIELDS.map((field) => [`${REDIS_KEY}${field}`]),
			[accessKeyOf(NEWCOMER)],
			[`${REDIS_KEY}${NEWCOMER}`],
			[`${REDIS_KEY}idx:shopOwner:${SHOP_OWNER_ID}`]
		])
		expect(hDel.mock.calls).toEqual(INDEXED_FIELDS.map((field) => [`${REDIS_KEY}idx:shopOwner:${SHOP_OWNER_ID}`, field]))
	})

	// A shop owner with no live session revokes quietly: `hKeys` on a missing key answers an empty array,
	// and the routine issues no `del` at all rather than guessing at a key to tidy.
	it('completes without a single delete when the account has no live session', async () => {
		hKeys.mockResolvedValueOnce([])

		await expect(endEveryShopOwnerSession(SHOP_OWNER_ID)).resolves.toBeUndefined()

		expect(del).not.toHaveBeenCalled()
	})
})
