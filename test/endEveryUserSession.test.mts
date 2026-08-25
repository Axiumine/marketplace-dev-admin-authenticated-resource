import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { armSessionIndex } from './sessionIndexMocks.mts'

const hKeys = vi.fn()
const hGet = vi.fn()
const del = vi.fn()
const hDel = vi.fn()

// Only the client is faked, as in the other two revocation suites: `revokeAllSessionsForAccount` runs for
// real, so what this reads is the Redis conversation itself rather than that a mock was called.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hKeys, hGet, del, hDel } }))

const { endEveryUserSession } = await import('../src/lib/auth/endEveryUserSession.mts')

const REDIS_KEY = 'test:'
const USER_ID = '507f1f77bcf86cd799439011'
const FIELDS = ['a'.repeat(64), 'b'.repeat(64)]

// The access key each session records under `accessKey` (R54). Uppercase, so it is read rather than derived.
const accessKeyOf = (field: string) => `${REDIS_KEY}${field}`.toUpperCase()

beforeEach(() => {
	armSessionIndex({ hKeys, hGet, del, hDel }, REDIS_KEY, FIELDS)
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('endEveryUserSession', () => {
	/*
	 * ⚠️ **`idx:user:`, and on this call the tier is the whole safety of it.** The customer, the shop owner
	 * and the operator share one `REDIS_KEY` prefix and the tier is the only thing separating one account's
	 * index from another's — so `TIER.shopOwner` here, copied from the function this one mirrors, would read
	 * the index of a shop owner carrying the same `_id`. None exists, `hKeys` answers empty, nothing is
	 * deleted, no error is raised, and `userUpdateStatus` reports a customer signed out whose sessions are
	 * all still live. It is the failure that looks exactly like success.
	 */
	it('reads the user index of the account it was given', async () => {
		await endEveryUserSession(USER_ID)

		// Twice: the second is E17-S04's re-read, and both keys are asserted so a re-read of another tier's
		// index could not pass as "at least one right key".
		expect(hKeys.mock.calls).toEqual([[`${REDIS_KEY}idx:user:${USER_ID}`], [`${REDIS_KEY}idx:user:${USER_ID}`]])
	})

	// Asserted as an absence, because the wrong tier is a silent no-op rather than an error: nothing this
	// function does may name the two other indexes an account id could be read under.
	it('touches neither the shopOwner nor the admin index', async () => {
		await endEveryUserSession(USER_ID)

		const keysTouched = [...hKeys.mock.calls, ...del.mock.calls, ...hDel.mock.calls].flat().join(' ')

		expect(keysTouched).not.toContain('idx:shopOwner:')
		expect(keysTouched).not.toContain('idx:admin:')
	})

	// The id arrives as an ObjectId from the resolver's argument and as a string from a test or a future
	// caller; both have to reach the same index key, so the interpolation is asserted rather than assumed.
	it('builds the same key from an ObjectId as from its string', async () => {
		await endEveryUserSession(new Types.ObjectId(USER_ID))

		expect(hKeys.mock.calls.flat()).toEqual([`${REDIS_KEY}idx:user:${USER_ID}`, `${REDIS_KEY}idx:user:${USER_ID}`])
	})

	// One single-key `del` per key, both halves of every filed session, then the index key last — the
	// routine's own contract, read here through its second cross-account call site.
	it('deletes every filed session and the index last, one key per command', async () => {
		await endEveryUserSession(USER_ID)

		expect(del.mock.calls).toEqual([
			...FIELDS.map((field) => [accessKeyOf(field)]),
			...FIELDS.map((field) => [`${REDIS_KEY}${field}`]),
			[`${REDIS_KEY}idx:user:${USER_ID}`]
		])
	})

	/*
	 * ⚠️ **The access tokens go too, and the operator never sees one** (R54). Suspending a customer is the
	 * call where that matters most: the operator holds none of that account's tokens, so without the
	 * `accessKey` read out of each session hash the suspended customer would keep a working bearer token
	 * for up to its whole lifetime after being disabled. Nothing beyond those two keys per session and the
	 * index is touched.
	 */
	it('deletes both halves of every session and nothing else', async () => {
		await endEveryUserSession(USER_ID)

		expect(hGet.mock.calls).toEqual(FIELDS.map((field) => [`${REDIS_KEY}${field}`, 'accessKey']))
		expect(del).toHaveBeenCalledTimes(FIELDS.length * 2 + 1)
	})

	/*
	 * ⚠️ **The customer logging in while the operator disables them does not keep that session** (E17-S04).
	 * The likelier race of the three call sites: a customer is at their keyboard, shopping, with no idea a
	 * write is landing. The re-read catches the newcomer, and the index key survives until it has been
	 * revoked — deleting it on the first round would leave that session live with nothing able to name it.
	 */
	it('revokes a session that appeared during the revoke, and keeps the index until it has', async () => {
		const NEWCOMER = 'c'.repeat(64)

		hKeys
			.mockResolvedValueOnce(FIELDS)
			.mockResolvedValueOnce([...FIELDS, NEWCOMER])
			.mockResolvedValueOnce([...FIELDS, NEWCOMER])

		await endEveryUserSession(USER_ID)

		expect(del.mock.calls).toEqual([
			...FIELDS.map((field) => [accessKeyOf(field)]),
			...FIELDS.map((field) => [`${REDIS_KEY}${field}`]),
			[accessKeyOf(NEWCOMER)],
			[`${REDIS_KEY}${NEWCOMER}`],
			[`${REDIS_KEY}idx:user:${USER_ID}`]
		])
		expect(hDel.mock.calls).toEqual(FIELDS.map((field) => [`${REDIS_KEY}idx:user:${USER_ID}`, field]))
	})

	// A customer with no live session revokes quietly: `hKeys` on a missing key answers an empty array, and
	// the routine issues no `del` at all rather than guessing at a key to tidy. The ordinary case, since a
	// customer who has never signed in is exactly the account most likely to be suspended.
	it('completes without a single delete when the account has no live session', async () => {
		hKeys.mockResolvedValueOnce([])

		await expect(endEveryUserSession(USER_ID)).resolves.toBeUndefined()

		expect(del).not.toHaveBeenCalled()
	})
})
