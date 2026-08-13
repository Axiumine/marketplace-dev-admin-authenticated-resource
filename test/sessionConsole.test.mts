import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const funSessions = vi.fn()
const funReuseEvents = vi.fn()
const funRevokeSession = vi.fn()
const funRevokeAllSessions = vi.fn()
const captureException = vi.fn()

vi.mock('@lib/session/funSessions.mjs', () => ({ funSessions }))
vi.mock('@lib/session/funReuseEvents.mjs', () => ({ funReuseEvents }))
vi.mock('@lib/session/funRevokeSession.mjs', () => ({ funRevokeSession }))
vi.mock('@lib/session/funRevokeAllSessions.mjs', () => ({ funRevokeAllSessions }))
// The lib layer is stubbed and covered for real in `sessionLib.test.mts`; what this file asserts is what
// the *resolvers* pass down and what the schema lets back out. tryCatchRethrow is NOT mocked — only its
// Sentry sink is, so a failure really travels through the wrapper each resolver puts around its lib.
vi.mock('@sentry/node', () => ({ captureException }))
// Pulled in transitively by the mutation context type chain; nothing here talks to Redis.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: {} }))

const { sessions } = await import('../src/graphQLApi/schema/queries/sessions.mts')
const { reuseEvents } = await import('../src/graphQLApi/schema/queries/reuseEvents.mts')
const { revokeSession } = await import('../src/graphQLApi/schema/mutations/revokeSession.mts')
const { revokeAllSessions } = await import('../src/graphQLApi/schema/mutations/revokeAllSessions.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
const ctx = { state: { user: { _id, email: 'operator@marketplace.test' } } } as never

const ACCOUNT = '68b0f2c1a2b3c4d5e6f70819'
const FIELD = 'a'.repeat(64)

const ROW = { id: FIELD, tier: 'shopOwner', mintedAt: '1754784000000', familyId: 'fam-1' }
const EVENT = {
	familyId: 'fam-1',
	tier: 'shopOwner',
	accountId: ACCOUNT,
	action: 'refreshTokenReplayed',
	at: '1754784000000'
}

beforeEach(() => {
	funSessions.mockReset().mockResolvedValue([ROW])
	funReuseEvents.mockReset().mockResolvedValue([EVENT])
	funRevokeSession.mockReset().mockResolvedValue(true)
	funRevokeAllSessions.mockReset().mockResolvedValue(2)
	captureException.mockReset()
})

describe('sessions', () => {
	it('lists the account the arguments name, both halves', async () => {
		await expect(sessions.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT })).resolves.toStrictEqual([ROW])

		expect(funSessions).toHaveBeenCalledExactlyOnceWith('shopOwner', ACCOUNT)
	})

	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funSessions.mockImplementationOnce(() => throwNotFoundError('no such account'))

		expect(await rejection(sessions.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT }))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'no such account'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('redis down')
		funSessions.mockRejectedValueOnce(error)

		await expect(sessions.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('reuseEvents', () => {
	it('reads the trail of the account the arguments name', async () => {
		await expect(reuseEvents.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT })).resolves.toStrictEqual([EVENT])

		expect(funReuseEvents).toHaveBeenCalledExactlyOnceWith('shopOwner', ACCOUNT)
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('redis down')
		funReuseEvents.mockRejectedValueOnce(error)

		await expect(reuseEvents.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('revokeSession', () => {
	/*
	 * ⚠️ The operator's id comes off the Redis session and meters the rate limit; it is not an argument, so
	 * nobody can revoke on somebody else's allowance. It travels no further than the limiter — E17's open
	 * question 4 answered "not attributable", so it never reaches the event trail.
	 */
	it('revokes on behalf of the session account and answers whether a live session went', async () => {
		await expect(revokeSession.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT, id: FIELD }, ctx)).resolves.toBe(true)

		expect(funRevokeSession).toHaveBeenCalledExactlyOnceWith(_id, 'shopOwner', ACCOUNT, FIELD)
	})

	// `false` is the already-ended case, and it must reach the console intact: reporting it as an error
	// would train an operator to retry a call that has already done everything it can.
	it('passes an already-ended session through as false rather than as a failure', async () => {
		funRevokeSession.mockResolvedValueOnce(false)

		await expect(revokeSession.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT, id: FIELD }, ctx)).resolves.toBe(false)
	})

	it('preserves the status of a rate-limit refusal raised downstream', async () => {
		const { throwTooManyRequestsError } = await import('@axiumine/koa-utils/graphQL/throw/throwTooManyRequestsError')
		funRevokeSession.mockImplementationOnce(() => throwTooManyRequestsError('slow down'))

		expect(await rejection(revokeSession.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT, id: FIELD }, ctx))).toEqual({
			message: 'Too Many Requests',
			http: { status: 429 },
			description: 'slow down'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('redis down')
		funRevokeSession.mockRejectedValueOnce(error)

		await expect(revokeSession.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT, id: FIELD }, ctx)).rejects.toThrow(
			'Internal Server Error'
		)
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('revokeAllSessions', () => {
	it('revokes on behalf of the session account and answers the count', async () => {
		await expect(revokeAllSessions.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT }, ctx)).resolves.toBe(2)

		expect(funRevokeAllSessions).toHaveBeenCalledExactlyOnceWith(_id, 'shopOwner', ACCOUNT)
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('redis down')
		funRevokeAllSessions.mockRejectedValueOnce(error)

		await expect(revokeAllSessions.resolve(null, { tier: 'shopOwner', accountId: ACCOUNT }, ctx)).rejects.toThrow(
			'Internal Server Error'
		)
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

/*
 * E17-S02 asks for the Admin-tier gate's *reject* path to have a test of its own, and it does — but not
 * here, because the gate is not here. `assertTier(redData.tier, TIER.admin)` runs in this service's
 * middleware (`authorizationAuthenticatedResourceHandler.mts`), one layer above every resolver in it, so
 * a console resolver checking the tier again would be asserting a condition that cannot be false by the
 * time it runs. The reject path is covered by AB-02 and AB-03 in
 * `authorizationAuthenticatedResourceHandler.test.mts`: a session minted for the `shopOwner` or `user`
 * tier is refused with 403, and a session carrying no tier at all is refused too, failing closed.
 *
 * E17-S07's loop is not here either, for the same kind of reason: it has to run the *real* libs against a
 * *real* seeded store to mean anything, and this file stubs the libs. It lives in `sessionNoLeak.test.mts`.
 */
