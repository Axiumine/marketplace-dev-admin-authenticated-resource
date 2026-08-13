import { createHash } from 'node:crypto'

import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const hGetAll = vi.fn()
const hGet = vi.fn()
const hKeys = vi.fn()
const hDel = vi.fn()
const del = vi.fn()
const lRange = vi.fn()

/** The three commands `assertUnderRateLimit` issues, so a metered revocation is visible rather than merely allowed. */
const incr = vi.fn()
const ttl = vi.fn()
const expire = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({
	redisClient: { hGetAll, hGet, hKeys, hDel, del, lRange, incr, ttl, expire }
}))

const { funSessions } = await import('../src/lib/session/funSessions.mts')
const { funRevokeSession } = await import('../src/lib/session/funRevokeSession.mts')
const { funRevokeAllSessions } = await import('../src/lib/session/funRevokeAllSessions.mts')
const { funReuseEvents } = await import('../src/lib/session/funReuseEvents.mts')
const { SESSION_WRITES_PER_HOUR, SESSION_WRITE_WINDOW_SECONDS } = await import('../src/lib/session/guardSessionWrite.mts')

const OPERATOR = new Types.ObjectId('507f1f77bcf86cd799439011')
const ACCOUNT = '68b0f2c1a2b3c4d5e6f70819'
const INDEX_KEY = `test:idx:shopOwner:${ACCOUNT}`
const TRAIL_KEY = `test:reuse:shopOwner:${ACCOUNT}`

/*
 * Two index fields, written out as digests because that is what they are: the SHA-256 of a prefixed
 * refresh token. No token appears anywhere in this file — the row id is the digest, and `LEAKED` below
 * exists only so the substring assertions have something real to fail against.
 */
const FIELD_A = 'a'.repeat(64)
const FIELD_B = 'b'.repeat(64)
const FIELD_C = 'c'.repeat(64)
const FIELD_D = 'd'.repeat(64)

/** The token these rows would have been minted from, if this suite ever let one near the store. */
const LEAKED = 'refresh:27119032-9043-4a9f-bd4c-9d06fd576290'

/*
 * The access key a session hash records under `accessKey` (R54). Uppercase, so it cannot be confused with
 * anything the revocation could derive from the field it holds: the only way to name it is to read it.
 */
const accessKeyOf = (field: string) => `test:${field}`.toUpperCase()

/** A refresh session hash, exactly the five fields `IRefreshData` requires. */
const session = (familyId: string, originalLogin: string) => ({
	_id: ACCOUNT,
	tier: 'shopOwner',
	familyId,
	originalLogin,
	sessionCapDays: '30'
})

/**
 * The counter key a metered revocation increments.
 *
 * ⚠️ Spelled from the parts rather than imported from `assertUnderRateLimit`, so the assertion is that the
 * operator's *account id* is what gets metered — and that it arrives hashed. A scan of the limiter's
 * keyspace must not read back as a list of which operators ended whose sessions.
 */
const meterKey = (operation: string, operator: string) =>
	`test:rl:session:${operation}:${createHash('sha256').update(operator).digest('hex')}`

beforeEach(() => {
	vi.stubEnv('REDIS_KEY', 'test:')
	hGetAll.mockReset()
	// Every session carries a bound access key, which is the steady state after 2026-08-13: `retireAccessSession`
	// reads this field, and a revocation ends both halves or it has not ended the session.
	hGet.mockReset().mockImplementation((key: string) => Promise.resolve(key.toUpperCase()))
	hKeys.mockReset().mockResolvedValue([])
	hDel.mockReset()
	del.mockReset().mockResolvedValue(1)
	lRange.mockReset().mockResolvedValue([])
	// One write inside the window, with its TTL already armed — the state every test but the metered ones
	// wants, and the one that makes `expire` a signal rather than noise.
	incr.mockReset().mockResolvedValue(1)
	ttl.mockReset().mockResolvedValue(SESSION_WRITE_WINDOW_SECONDS)
	expire.mockReset()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('funSessions', () => {
	it('reads one index key and one hash per field, and never scans the keyspace', async () => {
		hGetAll.mockImplementation((key: string) =>
			Promise.resolve(
				key === INDEX_KEY ? { [FIELD_A]: JSON.stringify({ tier: 'shopOwner', mintedAt: '1000' }) } : session('fam-1', '1000')
			)
		)

		await expect(funSessions('shopOwner', ACCOUNT)).resolves.toStrictEqual([
			{ id: FIELD_A, tier: 'shopOwner', mintedAt: '1000', familyId: 'fam-1' }
		])
		// The index key first, then the key that field names — two single-key reads, no `SCAN`, no `KEYS`.
		expect(hGetAll.mock.calls).toStrictEqual([[INDEX_KEY], [`test:${FIELD_A}`]])
	})

	it('takes every field of a row from the session hash, not from the index entry', async () => {
		// The index entry disagrees with the session on both fields it duplicates. The session wins: it is
		// the record the platform authenticates against, and an operator deciding what to end reads that one.
		hGetAll.mockImplementation((key: string) =>
			Promise.resolve(
				key === INDEX_KEY ? { [FIELD_A]: JSON.stringify({ tier: 'admin', mintedAt: '999999' }) } : session('fam-1', '1000')
			)
		)

		await expect(funSessions('shopOwner', ACCOUNT)).resolves.toStrictEqual([
			{ id: FIELD_A, tier: 'shopOwner', mintedAt: '1000', familyId: 'fam-1' }
		])
	})

	it('drops a field whose session has already expired instead of listing it as live', async () => {
		hGetAll.mockImplementation((key: string) => {
			if (key === INDEX_KEY) return Promise.resolve({ [FIELD_A]: '{}', [FIELD_B]: '{}' })

			// `hGetAll` on a missing key answers `{}` — the whole liveness test, and the state E15-S03's
			// per-field TTL has not yet cleaned up.
			return Promise.resolve(key === `test:${FIELD_A}` ? session('fam-1', '1000') : {})
		})

		const rows = await funSessions('shopOwner', ACCOUNT)

		expect(rows).toHaveLength(1)
		expect(rows[0]?.id).toBe(FIELD_A)
		// A read that pruned would be a read that needs a rate limit and an audit line of its own.
		expect(hDel).not.toHaveBeenCalled()
		expect(del).not.toHaveBeenCalled()
	})

	it('sorts newest login first so the table does not reshuffle between polls', async () => {
		hGetAll.mockImplementation((key: string) => {
			if (key === INDEX_KEY) return Promise.resolve({ [FIELD_A]: '{}', [FIELD_B]: '{}' })

			return Promise.resolve(key === `test:${FIELD_A}` ? session('fam-1', '1000') : session('fam-2', '2000'))
		})

		await expect(funSessions('shopOwner', ACCOUNT)).resolves.toStrictEqual([
			{ id: FIELD_B, tier: 'shopOwner', mintedAt: '2000', familyId: 'fam-2' },
			{ id: FIELD_A, tier: 'shopOwner', mintedAt: '1000', familyId: 'fam-1' }
		])
	})

	it('breaks a tie on the id, so two logins in the same millisecond keep one order', async () => {
		hGetAll.mockImplementation((key: string) => {
			if (key === INDEX_KEY) return Promise.resolve({ [FIELD_B]: '{}', [FIELD_A]: '{}' })

			return Promise.resolve(key === `test:${FIELD_A}` ? session('fam-1', '1000') : session('fam-2', '1000'))
		})

		await expect(funSessions('shopOwner', ACCOUNT)).resolves.toStrictEqual([
			{ id: FIELD_A, tier: 'shopOwner', mintedAt: '1000', familyId: 'fam-1' },
			{ id: FIELD_B, tier: 'shopOwner', mintedAt: '1000', familyId: 'fam-2' }
		])
	})

	it('answers an empty list for an account with no index at all', async () => {
		hGetAll.mockResolvedValue({})

		await expect(funSessions('shopOwner', ACCOUNT)).resolves.toStrictEqual([])
		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(INDEX_KEY)
	})

	it('names the index key by tier as well as id, so two tiers colliding on an id stay apart', async () => {
		hGetAll.mockResolvedValue({})

		await funSessions('admin', ACCOUNT)

		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(`test:idx:admin:${ACCOUNT}`)
	})

	it('puts no token, and no substring of one, in what it returns', async () => {
		hGetAll.mockImplementation((key: string) =>
			Promise.resolve(
				key === INDEX_KEY ? { [FIELD_A]: JSON.stringify({ tier: 'shopOwner', mintedAt: '1000' }) } : session('fam-1', '1000')
			)
		)

		const serialised = JSON.stringify(await funSessions('shopOwner', ACCOUNT))

		expect(serialised).not.toContain(LEAKED)
		expect(serialised).not.toContain('27119032-9043-4a9f-bd4c-9d06fd576290')
	})
})

describe('funRevokeSession', () => {
	it('deletes the session key first and prunes its index field second', async () => {
		await expect(funRevokeSession(OPERATOR, 'shopOwner', ACCOUNT, FIELD_A)).resolves.toBe(true)

		// Single-key `del`s (BCON-08), the session's own built from the field verbatim — no rehashing, no token.
		expect(del.mock.calls).toStrictEqual([[accessKeyOf(FIELD_A)], [`test:${FIELD_A}`]])
		expect(hDel).toHaveBeenCalledExactlyOnceWith(INDEX_KEY, FIELD_A)
		expect(del.mock.invocationCallOrder[1]).toBeLessThan(hDel.mock.invocationCallOrder[0] as number)
	})

	/*
	 * ⚠️ R54: ending a session ends the access token it minted, and reads the key for it *before* deleting the
	 * hash that holds it. The reverse order can read nothing at all, and leaves the account a working bearer
	 * token for up to 91 minutes after an operator was told the session was over.
	 */
	it('retires the access token the session minted, before deleting the session', async () => {
		await funRevokeSession(OPERATOR, 'shopOwner', ACCOUNT, FIELD_A)

		expect(hGet).toHaveBeenCalledExactlyOnceWith(`test:${FIELD_A}`, 'accessKey')
		expect(hGet.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[1] as number)
	})

	// A session minted before the field existed carries no bound key, and is ended exactly as it always was.
	it('ends a session that carries no bound access key, deleting only the session', async () => {
		hGet.mockResolvedValue(null)

		await expect(funRevokeSession(OPERATOR, 'shopOwner', ACCOUNT, FIELD_A)).resolves.toBe(true)

		expect(del).toHaveBeenCalledExactlyOnceWith(`test:${FIELD_A}`)
	})

	it('prunes the index field of an already-dead session and answers false', async () => {
		del.mockResolvedValue(0)

		// The case that repairs the list: no session was ended, so the answer is `false` — and the row stops
		// being rendered, which is the whole reason the `hDel` is unconditional.
		await expect(funRevokeSession(OPERATOR, 'shopOwner', ACCOUNT, FIELD_A)).resolves.toBe(false)
		expect(hDel).toHaveBeenCalledExactlyOnceWith(INDEX_KEY, FIELD_A)
	})

	it('meters the operator by account id, hashed, and refuses over the cap', async () => {
		incr.mockResolvedValue(SESSION_WRITES_PER_HOUR + 1)

		const outcome = await rejection(funRevokeSession(OPERATOR, 'shopOwner', ACCOUNT, FIELD_A))

		expect(outcome.message).toBe('Too Many Requests')
		expect(outcome.http).toEqual({ status: 429 })
		expect(incr).toHaveBeenCalledExactlyOnceWith(meterKey('revoke', OPERATOR.toString()))
		// The refusal lands before the store is touched: a metered call must not half-revoke, and must not
		// read a session it is not going to end either.
		expect(hGet).not.toHaveBeenCalled()
		expect(del).not.toHaveBeenCalled()
		expect(hDel).not.toHaveBeenCalled()
	})

	it('names the index key by the tier it was given', async () => {
		await funRevokeSession(OPERATOR, 'user', ACCOUNT, FIELD_A)

		expect(hDel).toHaveBeenCalledExactlyOnceWith(`test:idx:user:${ACCOUNT}`, FIELD_A)
	})
})

describe('funRevokeAllSessions', () => {
	it('revokes through E15-S04’s routine and answers how many sessions there were', async () => {
		// Two fields on the first read, none on the re-read: the whole account was open and is now closed,
		// so the index key itself goes too.
		hKeys.mockResolvedValueOnce([FIELD_A, FIELD_B]).mockResolvedValueOnce([])

		await expect(funRevokeAllSessions(OPERATOR, 'shopOwner', ACCOUNT)).resolves.toBe(2)
		// Both halves of both sessions, the access ones first (R54), and the index key last of all.
		expect(del.mock.calls).toStrictEqual([
			[accessKeyOf(FIELD_A)],
			[accessKeyOf(FIELD_B)],
			[`test:${FIELD_A}`],
			[`test:${FIELD_B}`],
			[INDEX_KEY]
		])
	})

	it('leaves the index key alive when a login lands mid-revoke, and prunes only what it ended', async () => {
		/*
		 * E17-S04's race, driven to the bound: a new field appears on every re-read, so the routine never
		 * sees a clean one and gives up after three rounds. The index key survives holding the newcomer it
		 * did not reach — an orphaned field is recoverable, a destroyed index is not, and destroying it here
		 * would leave that session live and listed nowhere.
		 */
		hKeys
			.mockResolvedValueOnce([FIELD_A])
			.mockResolvedValueOnce([FIELD_A, FIELD_B])
			.mockResolvedValueOnce([FIELD_A, FIELD_B, FIELD_C])
			.mockResolvedValueOnce([FIELD_A, FIELD_B, FIELD_C, FIELD_D])

		// Three, not four: the count is what was actually revoked, so the caller never reports a session
		// that is still open.
		await expect(funRevokeAllSessions(OPERATOR, 'shopOwner', ACCOUNT)).resolves.toBe(3)
		expect(del).not.toHaveBeenCalledWith(INDEX_KEY)
		expect(hDel.mock.calls).toStrictEqual([
			[INDEX_KEY, FIELD_A],
			[INDEX_KEY, FIELD_B],
			[INDEX_KEY, FIELD_C]
		])
	})

	it('meters the operator on its own bucket, separate from the single revoke', async () => {
		incr.mockResolvedValue(SESSION_WRITES_PER_HOUR + 1)

		const outcome = await rejection(funRevokeAllSessions(OPERATOR, 'shopOwner', ACCOUNT))

		expect(outcome.message).toBe('Too Many Requests')
		expect(outcome.http).toEqual({ status: 429 })
		// `revokeAll`, not `revoke`: an afternoon spent ending single sessions must not spend the allowance
		// for the call an operator makes when an account is confirmed compromised.
		expect(incr).toHaveBeenCalledExactlyOnceWith(meterKey('revokeAll', OPERATOR.toString()))
		expect(hKeys).not.toHaveBeenCalled()
	})

	it('answers zero for an account holding nothing, issuing no delete at all', async () => {
		await expect(funRevokeAllSessions(OPERATOR, 'shopOwner', ACCOUNT)).resolves.toBe(0)
		expect(del).not.toHaveBeenCalled()
	})
})

describe('funReuseEvents', () => {
	const event = {
		familyId: 'fam-1',
		tier: 'shopOwner',
		accountId: ACCOUNT,
		action: 'refreshTokenReplayed',
		at: '1754784000000'
	}

	it('reads one key over the trail’s own bound, newest first', async () => {
		lRange.mockResolvedValue([JSON.stringify(event)])

		await expect(funReuseEvents('shopOwner', ACCOUNT)).resolves.toStrictEqual([event])
		// `0, 49` — fifty entries, the bound `recordReuseEvent` trims to on every append.
		expect(lRange).toHaveBeenCalledExactlyOnceWith(TRAIL_KEY, 0, 49)
	})

	it('answers an empty trail for an account that has never had a lineage revoked', async () => {
		await expect(funReuseEvents('shopOwner', ACCOUNT)).resolves.toStrictEqual([])
	})

	it('names the trail key by tier as well as id', async () => {
		await funReuseEvents('admin', ACCOUNT)

		expect(lRange).toHaveBeenCalledExactlyOnceWith(`test:reuse:admin:${ACCOUNT}`, 0, 49)
	})

	it('returns nothing a token could be recovered from', async () => {
		lRange.mockResolvedValue([JSON.stringify(event), JSON.stringify({ ...event, action: 'sessionCapReached' })])

		const serialised = JSON.stringify(await funReuseEvents('shopOwner', ACCOUNT))

		expect(serialised).not.toContain(LEAKED)
		expect(serialised).not.toContain('27119032-9043-4a9f-bd4c-9d06fd576290')
		// The five fields of `IReuseEvent`, and no sixth that a token could hide in.
		expect(Object.keys(JSON.parse(serialised)[0] as object)).toStrictEqual(['familyId', 'tier', 'accountId', 'action', 'at'])
	})
})
