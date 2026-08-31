import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accessKeyOf, armSessionIndex, INDEXED_FIELDS, REDIS_KEY } from './sessionIndexMocks.mts'

const hKeys = vi.fn()
const hGet = vi.fn()
const del = vi.fn()
const hDel = vi.fn()

const adminFind = vi.fn()
const shopOwnerFind = vi.fn()
const userFind = vi.fn()

// The client is faked and `revokeAllSessionsForAccount` runs for real, as in the three per-account
// revocation suites: what this file reads is the Redis conversation a platform-wide sweep actually holds.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hKeys, hGet, del, hDel } }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Admin', () => ({ Admin: { find: adminFind } }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({ ShopOwner: { find: shopOwnerFind } }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { find: userFind } }))

const { endEveryPlatformSession } = await import('../src/lib/keygrip/endEveryPlatformSession.mts')

/**
 * One admin, two shop owners, three customers — deliberately three different sizes.
 *
 * A sweep that summed the tiers wrongly, or read one collection twice, lands on the same total when the
 * three are the same size. With 1 : 2 : 3 every wrong arrangement of the three counts is a different
 * number from the right one.
 */
const ADMINS = ['507f1f77bcf86cd799439011']
const SHOP_OWNERS = ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022']
const USERS = ['507f1f77bcf86cd799439031', '507f1f77bcf86cd799439032', '507f1f77bcf86cd799439033']

/** A collection answering with ids, shaped as the `find(...).lean()` the sweep calls. */
const holding = (ids: string[]) => ({ lean: () => Promise.resolve(ids.map((id) => ({ _id: new Types.ObjectId(id) }))) })

/** The index key of one account, spelled from the parts rather than through `sessionKeys.mts`. */
const indexKeyOf = (tier: string, id: string) => `${REDIS_KEY}idx:${tier}:${id}`

/**
 * Arms `hKeys` so the named index keys reject and every other account revokes normally.
 *
 * The throw is placed on the *first* Redis command a revocation issues, so the account it belongs to
 * contributes nothing at all — which is what makes the ended count a clean multiple of the accounts that
 * did get through.
 */
const failingOn = (failures: Record<string, string>) =>
	hKeys.mockImplementation((key: string) =>
		failures[key] ? Promise.reject(new Error(failures[key] as string)) : Promise.resolve(INDEXED_FIELDS)
	)

/** Every index key the sweep must read, in the order the three tiers run. */
const EVERY_INDEX_KEY = [
	...ADMINS.map((id) => indexKeyOf('admin', id)),
	...SHOP_OWNERS.map((id) => indexKeyOf('shopOwner', id)),
	...USERS.map((id) => indexKeyOf('user', id))
]

beforeEach(() => {
	armSessionIndex({ hKeys, hGet, del, hDel }, REDIS_KEY, INDEXED_FIELDS)
	adminFind.mockReset().mockReturnValue(holding(ADMINS))
	shopOwnerFind.mockReset().mockReturnValue(holding(SHOP_OWNERS))
	userFind.mockReset().mockReturnValue(holding(USERS))
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('endEveryPlatformSession', () => {
	/*
	 * ⚠️ **The filter is empty and the projection is `_id`, and both are load-bearing.** A filter would
	 * make the sweep partial — the point of it is that no account keeps a session — and a wider projection
	 * would pull every customer's decrypted personal data (ADR-029) through this process to read a field
	 * it never touches.
	 */
	it('reads every account of all three collections, by id and nothing else', async () => {
		await endEveryPlatformSession()

		expect(adminFind).toHaveBeenCalledExactlyOnceWith({}, '_id')
		expect(shopOwnerFind).toHaveBeenCalledExactlyOnceWith({}, '_id')
		expect(userFind).toHaveBeenCalledExactlyOnceWith({}, '_id')
	})

	/*
	 * ⚠️ **Per account and per tier, because the keyspace can be read no other way.** BCON-08 bans `SCAN`
	 * and `KEYS`, so there is no list of live sessions to walk: an account's sessions are one index hash
	 * named by tier and id. The tier is what separates them — the same `_id` under `admin` and under
	 * `user` are two different accounts — so every key is asserted, in order, rather than counted.
	 */
	it('reads the index of every account, one tier at a time', async () => {
		await endEveryPlatformSession()

		// Twice per account: the second read is the routine's own re-read, which catches a login that landed
		// mid-revoke.
		expect(hKeys.mock.calls.flat()).toEqual(EVERY_INDEX_KEY.flatMap((key) => [key, key]))
	})

	/*
	 * ⚠️ **The admin tier is swept too, so the admin who pressed retire is signed out by their own
	 * retirement.** No exemption, for the reason `endEverySession` records: an exemption is granted to
	 * whichever session sent the mutation, and someone holding a stolen admin cookie can send it.
	 */
	it('ends the admins’ sessions and not only the two customer-facing tiers', async () => {
		await endEveryPlatformSession()

		expect(hKeys).toHaveBeenCalledWith(indexKeyOf('admin', ADMINS[0] as string))
	})

	// Both halves of every session and then the index key, per account — the routine's contract, read here
	// through the one call site that applies it to the whole platform at once (R54).
	it('deletes both halves of every session it finds', async () => {
		await endEveryPlatformSession()

		expect(del.mock.calls).toEqual(
			EVERY_INDEX_KEY.flatMap((key) => [
				...INDEXED_FIELDS.map((field) => [accessKeyOf(field)]),
				...INDEXED_FIELDS.map((field) => [`${REDIS_KEY}${field}`]),
				[key]
			])
		)
		expect(hGet.mock.calls).toEqual(
			EVERY_INDEX_KEY.flatMap(() => INDEXED_FIELDS.map((field) => [`${REDIS_KEY}${field}`, 'accessKey']))
		)
	})

	/*
	 * The count is what the audit event reports, so it has to be the sum of the three tiers rather than
	 * the last one's — six accounts holding two sessions each.
	 */
	it('answers how many sessions it ended, across all three tiers', async () => {
		await expect(endEveryPlatformSession()).resolves.toEqual({
			ended: EVERY_INDEX_KEY.length * INDEXED_FIELDS.length,
			failed: 0,
			reason: ''
		})
	})

	// An empty platform revokes quietly: no ids, so no index to read and no key to guess at.
	it('issues no Redis command when no account exists at all', async () => {
		adminFind.mockReturnValue(holding([]))
		shopOwnerFind.mockReturnValue(holding([]))
		userFind.mockReturnValue(holding([]))

		await expect(endEveryPlatformSession()).resolves.toEqual({ ended: 0, failed: 0, reason: '' })

		expect(hKeys).not.toHaveBeenCalled()
		expect(del).not.toHaveBeenCalled()
	})

	// An account with nothing open costs one `hKeys` and no delete — `hKeys` on a missing key answers an
	// empty array, and the tier's total is the sessions it found rather than the accounts it read.
	it('counts sessions rather than accounts when an account holds none', async () => {
		hKeys.mockResolvedValue([])

		await expect(endEveryPlatformSession()).resolves.toEqual({ ended: 0, failed: 0, reason: '' })

		expect(hKeys).toHaveBeenCalledTimes(EVERY_INDEX_KEY.length)
		expect(del).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **The sweep is what closes the retirement window, so one account's Redis failure must not close it
	 * for everybody else** (R55). Before this, a single throw ended the tier it happened in *and* every tier
	 * after it, so an unlucky round trip on the first shop owner left every customer holding live sessions
	 * that a retired key still verifies on any service that has not adopted the retirement yet.
	 */
	it('keeps sweeping the rest of the platform when one account’s revoke throws', async () => {
		const failed = indexKeyOf('shopOwner', SHOP_OWNERS[0] as string)

		failingOn({ [failed]: 'Redis connection lost' })

		await expect(endEveryPlatformSession()).resolves.toEqual({
			ended: (EVERY_INDEX_KEY.length - 1) * INDEXED_FIELDS.length,
			failed: 1,
			reason: 'Redis connection lost'
		})

		// The tier the throw landed in finishes, and the tier after it still runs at all.
		expect(hKeys).toHaveBeenCalledWith(indexKeyOf('shopOwner', SHOP_OWNERS[1] as string))
		expect(hKeys).toHaveBeenCalledWith(indexKeyOf('user', USERS[0] as string))
	})

	// The count is what `funKeygripRetire` reports to the admin, so it has to be every tier's failures and
	// not the last tier's — the same summing the ended count needs, on the number that decides whether the
	// mutation answers at all.
	it('counts the failures of all three tiers', async () => {
		failingOn({
			[indexKeyOf('admin', ADMINS[0] as string)]: 'Redis connection lost',
			[indexKeyOf('user', USERS[2] as string)]: 'Redis connection lost'
		})

		await expect(endEveryPlatformSession()).resolves.toMatchObject({
			ended: (EVERY_INDEX_KEY.length - 2) * INDEXED_FIELDS.length,
			failed: 2
		})
	})

	/*
	 * One reason is kept and it is the first, for the reason `ISweepOutcome` records: a sweep that fails
	 * usually fails once, and a thousand copies of `Redis connection lost` is not a better answer than one.
	 *
	 * ⚠️ **Two failures in one tier and a third in another, because "first" is decided twice.** Each tier
	 * keeps the first of its own failures, and the three tiers are then merged in the order they ran — so a
	 * fixture that only ever failed one account per tier would let the second of those rules be wrong
	 * without a test noticing.
	 */
	it('reports the first failure’s reason and drops every later one', async () => {
		failingOn({
			[indexKeyOf('admin', ADMINS[0] as string)]: 'the first reason',
			[indexKeyOf('user', USERS[0] as string)]: 'the customer tier’s first reason',
			[indexKeyOf('user', USERS[1] as string)]: 'the last reason'
		})

		await expect(endEveryPlatformSession()).resolves.toEqual({
			ended: (EVERY_INDEX_KEY.length - 3) * INDEXED_FIELDS.length,
			failed: 3,
			reason: 'the first reason'
		})
	})

	/*
	 * The customer tier is last and its reason has the furthest to travel, so it is asserted on its own: a
	 * merge that only looked at the first two tiers would report an empty reason beside a non-zero
	 * `failed`, and the admin would be told how many accounts are standing and nothing about why.
	 *
	 * ⚠️ **Two failures, and the *first* of them is what must come out.** With one, a tier that kept the
	 * last of its failures instead of the first would answer identically here and be caught by nothing:
	 * this is the tier whose own reason is the one reported, so it is the tier where that has to be read.
	 */
	it('reports the last tier’s first reason when the two before it swept cleanly', async () => {
		failingOn({
			[indexKeyOf('user', USERS[0] as string)]: 'the customer tier’s reason',
			[indexKeyOf('user', USERS[1] as string)]: 'a later customer’s reason'
		})

		await expect(endEveryPlatformSession()).resolves.toEqual({
			ended: (EVERY_INDEX_KEY.length - 2) * INDEXED_FIELDS.length,
			failed: 2,
			reason: 'the customer tier’s reason'
		})
	})

	/*
	 * ⚠️ **A tier that cannot be listed is not a partial sweep and must not be reported as one.** The
	 * `find` sits outside the per-account catch on purpose: nothing was swept in that tier and no account
	 * of it was even named, so a `{ failed: 0 }` here would tell `funKeygripRetire` the platform is signed
	 * out when a third of it was never looked at.
	 */
	it('lets a collection that cannot be read through, rather than counting it as failed accounts', async () => {
		shopOwnerFind.mockReturnValue({ lean: () => Promise.reject(new Error('Mongo is unreachable')) })

		await expect(endEveryPlatformSession()).rejects.toThrow('Mongo is unreachable')

		// It gave up where it stood: the tier after the unreadable one never ran.
		expect(userFind).not.toHaveBeenCalled()
	})
})
