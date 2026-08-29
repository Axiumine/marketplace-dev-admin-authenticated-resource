import { createHash } from 'node:crypto'

import { unwrapKeygripKeys } from '@axiumine/marketplace-common/encryption/unwrapKeygripKeys'
import { wrapKeygripKeys } from '@axiumine/marketplace-common/encryption/wrapKeygripKeys'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { sha256Hex } from '@axiumine/marketplace-common/others/sha256Hex'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const hGetAll = vi.fn()
const evalRedis = vi.fn()
const captureMessage = vi.fn()

/** The three commands `assertUnderRateLimit` issues, so a metered write is visible rather than merely allowed. */
const incr = vi.fn()
const ttl = vi.fn()
const expire = vi.fn()

/*
 * ⚠️ Stubbed so that a *write* is visible, not so that one can happen. Neither function in this file may
 * file a holders row: both read with `readKeygrip`, and `loadKeygrip` — the variant that announces the
 * caller as a holder — would reach this stub instead of failing on a missing method, which is exactly the
 * regression the two `not.toHaveBeenCalled()` assertions below catch.
 */
const hSet = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGetAll, hSet, eval: evalRedis, incr, ttl, expire } }))
vi.mock('@sentry/node', () => ({ captureMessage }))

const { funKeygripRotate } = await import('../src/lib/keygrip/funKeygripRotate.mts')
const { funKeygripRetire } = await import('../src/lib/keygrip/funKeygripRetire.mts')
const { funKeygripStatus } = await import('../src/lib/keygrip/funKeygripStatus.mts')
const { KEYGRIP_WRITES_PER_HOUR, KEYGRIP_WRITE_WINDOW_SECONDS } = await import('../src/lib/keygrip/guardKeygripWrite.mts')

const KEK = Buffer.alloc(32, 7)
const ADMIN = new Types.ObjectId('507f1f77bcf86cd799439011')
const DAY_MS = 86_400_000

/**
 * `SESSION_CAP_DAYS_REMEMBERED` is 30, and the clock runs from the moment a key stopped signing rather
 * than from the moment it was minted — so an aged-out fixture ages the key *in front* of the one being
 * dropped, which is what says when the demotion happened.
 */
const AGED_OUT = 31

/**
 * The script, written out rather than imported from the source.
 *
 * ⚠️ Importing the constant would make the assertion compare the mutant against itself: Stryker blanks
 * string literals, and a test that reads the same literal it is checking passes on the empty one. This
 * copy is also the only place a reviewer can see what the rotation actually executes inside Redis
 * without opening the source next to it.
 */
const CAS = `if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'wrapped', ARGV[3], 'fp', ARGV[4])
redis.call('PUBLISH', ARGV[5], ARGV[2])
return 1`

/** A key whose age is stated in days, so each fixture reads as the rule it is there for. */
const aged = (id: string, days: number): IKeygripKeyMaterial => ({
	id,
	material: Buffer.alloc(64, id.length).toString('base64'),
	createdAt: new Date(Date.now() - days * DAY_MS).toISOString()
})

const YOUNG: IKeygripKeyMaterial[] = [aged('k2', 1), aged('k1', 5)]

/** The record as Redis holds it: three fields, the keys sealed under `KEK`. */
const seed = (keys: IKeygripKeyMaterial[], version = 3, kek = KEK) => {
	hGetAll.mockResolvedValueOnce({
		version: String(version),
		wrapped: wrapKeygripKeys(keys, version, kek),
		fp: keygripFingerprint(keys)
	})
}

/** The arguments the script was called with, named. */
const written = () => {
	const [script, options] = evalRedis.mock.calls[0] as [string, { keys: string[]; arguments: string[] }]
	const [expected, next, wrapped, fp, channel] = options.arguments

	return { script, key: options.keys[0], expected, next, wrapped, fp, channel }
}

/**
 * The two hashes a status read touches, answered **by key** rather than by call order.
 *
 * `seed` above can hand back one queued value because the rotation reads once; the status reads the record
 * and then the holders hash, and a fixture keyed on order would keep passing if the two reads swapped
 * places. Returns the record's fingerprint, which is what every holders row is compared against.
 */
const seedStatus = (keys: IKeygripKeyMaterial[], holders: Record<string, string>, version = 3, kek = KEK) => {
	const record = {
		version: String(version),
		wrapped: wrapKeygripKeys(keys, version, kek),
		fp: keygripFingerprint(keys)
	}

	hGetAll.mockImplementation((key: string) => Promise.resolve(key === 'test:keygrip' ? record : holders))

	return record.fp
}

/**
 * The counter key a metered write increments.
 *
 * ⚠️ Spelled here from the parts rather than imported from `assertUnderRateLimit`, so the assertion is
 * that the admin's *account id* is what gets metered. The digest is the point: a `KEYS` scan of the
 * limiter's keyspace must not read back as a list of which admins touched the signing keys.
 */
const meterKey = (operation: string, admin: string) =>
	`test:rl:keygrip:${operation}:${createHash('sha256').update(admin).digest('hex')}`

/** A holders row as `recordKeygripHolder` writes it. */
const heldAt = (fp: string, lastSeen: string) => `${fp}@${lastSeen}`

beforeEach(() => {
	vi.stubEnv('KEYGRIP_KEK', KEK.toString('base64'))
	vi.stubEnv('REDIS_KEY', 'test:')
	hGetAll.mockReset()
	hSet.mockReset()
	evalRedis.mockReset().mockResolvedValue(1)
	captureMessage.mockReset()
	// One write inside the window, with its TTL already armed — the state every test but the metered ones
	// wants, and the one that makes `expire` a signal rather than noise.
	incr.mockReset().mockResolvedValue(1)
	ttl.mockReset().mockResolvedValue(KEYGRIP_WRITE_WINDOW_SECONDS)
	expire.mockReset()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('funKeygripRotate', () => {
	it('seals the new key set under the next version and announces it on the channel', async () => {
		seed(YOUNG)

		await expect(funKeygripRotate(ADMIN)).resolves.toBeUndefined()

		const w = written()

		expect(w.script).toBe(CAS)
		expect(w.key).toBe('test:keygrip')
		expect(w.channel).toBe('test:keygrip:rotated')
		// The version the write is conditional on, and the one it installs. Both, because the pair is the
		// whole concurrency argument: another rotation landing in between moves the first number, and this
		// write then does nothing at all.
		expect(w.expected).toBe('3')
		expect(w.next).toBe('4')
		// Rotating is not holding: this service owns the KEK to reseal the record, it signs no cookie, and
		// a row of its own in the holders table would be a heartbeat nothing is behind.
		expect(hSet).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ The one property the fleet depends on: index 0 is what `Keygrip` signs with, and everything after
	 * it is what still verifies. A rotation that reordered or dropped a young key would log out every
	 * customer holding a cookie signed under it.
	 */
	it('prepends a fresh 64-byte key and leaves the ones still verifying cookies untouched', async () => {
		seed(YOUNG)

		await funKeygripRotate(ADMIN)

		const keys = unwrapKeygripKeys(written().wrapped, 4, KEK)

		expect(keys).toHaveLength(3)
		expect(Buffer.from(keys[0].material, 'base64')).toHaveLength(64)
		expect(keys[0].id).toBe('k3')
		expect(keys.slice(1)).toEqual(YOUNG)
		expect(written().fp).toBe(keygripFingerprint(keys))
	})

	// The retirement half of the same rule, through the real seal: a key demoted 30 days ago can have
	// signed nothing that is still presentable, so it is dropped and the array does not grow forever.
	it('drops a key that has aged past the longest session this platform issues', async () => {
		seed([aged('k2', AGED_OUT), aged('k1', AGED_OUT + 60)])

		await funKeygripRotate(ADMIN)

		expect(unwrapKeygripKeys(written().wrapped, 4, KEK).map((k) => k.id)).toEqual(['k3', 'k2'])
	})

	/*
	 * ⚠️ The rollback defence, asserted where it is created rather than only where it is read. The version
	 * is the AAD, so the blob written here is refused if it is ever filed under any other number — an
	 * attacker with write access to Redis and no key cannot put the fleet back on a retired key set by
	 * copying two strings.
	 */
	it('binds the sealed blob to the version it is filed under', async () => {
		seed(YOUNG)

		await funKeygripRotate(ADMIN)

		expect(() => unwrapKeygripKeys(written().wrapped, 3, KEK)).toThrow()
	})

	it('records who rotated, to what, in the only place this event is written down', async () => {
		seed(YOUNG)

		await funKeygripRotate(ADMIN)

		const fp = keygripFingerprint(unwrapKeygripKeys(written().wrapped, 4, KEK))

		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(
			`keygrip rotated to version 4 (${fp}) by admin ${sha256Hex(ADMIN.toString())}`,
			'info'
		)
	})

	/*
	 * ⚠️ E17 §6 question 5, as a test. The message becomes `event.message`, the one bag `sentryBeforeSend`
	 * does not walk, so an admin id written here reaches the vendor verbatim. Asserting the digest is
	 * present is not enough on its own — this asserts the id is *absent*, which is the half a future edit
	 * would break by appending a friendlier "by admin <id>" next to it.
	 */
	it('names the admin by digest and never by id', async () => {
		seed(YOUNG)

		await funKeygripRotate(ADMIN)

		const reported = JSON.stringify(captureMessage.mock.calls)

		expect(reported).toContain(sha256Hex(ADMIN.toString()))
		expect(reported).not.toContain(ADMIN.toString())
	})

	/*
	 * ⚠️ The story's own line, as a test: no path logs, returns or captures key material. The audit event
	 * is the one place tempted to carry it — "which key did we mint?" — and an admin who could read the
	 * material back would be able to mint a session cookie for any account on the platform.
	 */
	it('puts no key material in the audit event, not even the key it just minted', async () => {
		seed(YOUNG)

		await funKeygripRotate(ADMIN)

		const material = unwrapKeygripKeys(written().wrapped, 4, KEK).map((k) => k.material)
		const reported = JSON.stringify(captureMessage.mock.calls)

		expect(material).toHaveLength(3)
		for (const secret of material) expect(reported).not.toContain(secret)
	})

	/*
	 * ⚠️ Refused, not trimmed: five keys and none of them old enough means every one is still verifying
	 * somebody's cookie, and making room would log those customers out. 409 rather than 500 — the admin
	 * did nothing wrong, the answer is "not yet", and the message says how long.
	 */
	it('refuses a rotation that would retire a key still verifying cookies, and writes nothing', async () => {
		seed([aged('k5', 1), aged('k4', 2), aged('k3', 3), aged('k2', 4), aged('k1', 5)])

		const outcome = await rejection(funKeygripRotate(ADMIN))

		expect(outcome.message).toBe('Conflict')
		expect(outcome.http).toEqual({ status: 409 })
		expect(outcome.description).toMatch(
			/^KEYGRIP_ROTATE_CAP: the key set already holds 5 keys and none of them stopped signing more than 30 days ago\./
		)
		expect(evalRedis).not.toHaveBeenCalled()
		expect(captureMessage).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ The compare-and-set losing is the case this whole script exists for: two admins, one record.
	 * The loser must be told, and must not report a rotation that never happened — a Sentry line for a
	 * write Redis rejected would be an audit trail that lies.
	 */
	it('tells the admin to retry when another rotation landed first, and claims nothing', async () => {
		seed(YOUNG)
		evalRedis.mockResolvedValue(0)

		const outcome = await rejection(funKeygripRotate(ADMIN))

		expect(outcome.message).toBe('Conflict')
		expect(outcome.http).toEqual({ status: 409 })
		expect(outcome.description).toBe(
			'The keygrip record changed while this rotation was being prepared, so nothing was written. Another admin rotated a moment ago — reload the page and rotate again if you still need to.'
		)
		expect(captureMessage).not.toHaveBeenCalled()
	})

	// A record nobody has seeded. The admin's fix is the seed script, and the message says so — this
	// is the same refusal every signing service gives at boot, reached from the one service that writes.
	it('reports a missing record as a 500 carrying what to do about it', async () => {
		hGetAll.mockResolvedValueOnce({})

		const outcome = await rejection(funKeygripRotate(ADMIN))

		expect(outcome.message).toBe('Internal Server Error')
		expect(outcome.http).toEqual({ status: 500 })
		expect(outcome.description).toBe(
			'Error reported to Dev Team.KEYGRIP_RECORD_MISSING: no keygrip key set at "test:keygrip". Run "yarn seed:keygrip" in marketplace-db-setup before starting any service.'
		)
		expect(evalRedis).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ This service holding the wrong KEK is the one failure that must never end in a write. Rewrapping
	 * regardless would seal the record under a key none of the five signing services has, and every one of
	 * them would refuse to boot from that moment on — a platform-wide outage caused by the button meant to
	 * prevent one.
	 */
	it('writes nothing when its own KEK cannot open the record', async () => {
		seed(YOUNG, 3, Buffer.alloc(32, 8))

		const outcome = await rejection(funKeygripRotate(ADMIN))

		expect(outcome.message).toBe('Internal Server Error')
		expect(outcome.description).toMatch(
			/^Error reported to Dev Team\.KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 3 \(\w{12}\)\./
		)
		expect(evalRedis).not.toHaveBeenCalled()
		expect(captureMessage).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ Metered on the admin's account id, and metered *before* the record is read. Rotation reseals
	 * the record and publishes a version bump six processes act on, so a runaway client must cost one
	 * `INCR` rather than an unwrap — and the identity has to be the admin, because `app.proxy` is off and
	 * the address this process sees is nginx's own, one bucket the whole platform would share.
	 */
	it('meters the admin before it reads anything', async () => {
		seed(YOUNG)

		await funKeygripRotate(ADMIN)

		expect(incr).toHaveBeenCalledExactlyOnceWith(meterKey('rotate', '507f1f77bcf86cd799439011'))
		expect(expire).toHaveBeenCalledExactlyOnceWith(meterKey('rotate', '507f1f77bcf86cd799439011'), KEYGRIP_WRITE_WINDOW_SECONDS)
	})

	it('refuses the eleventh rotation of the hour without reading the record', async () => {
		incr.mockResolvedValue(KEYGRIP_WRITES_PER_HOUR + 1)

		const outcome = await rejection(funKeygripRotate(ADMIN))

		expect(outcome.message).toBe('Too Many Requests')
		expect(outcome.http).toEqual({ status: 429 })
		expect(hGetAll).not.toHaveBeenCalled()
		expect(evalRedis).not.toHaveBeenCalled()
	})
})

describe('funKeygripRetire', () => {
	/** Four keys: one signing, three still verifying. The middle ones are what a retire may take. */
	const FOUR: IKeygripKeyMaterial[] = [aged('k4', 1), aged('k3', 3), aged('k2', 6), aged('k1', 9)]

	/*
	 * The operation itself: the named key is gone, everything else is where it was, and the whole set is
	 * resealed under the next version. Every customer holding a cookie signed by `k2` is logged out by
	 * this — deliberately, which is why it is its own button and not something rotation does quietly.
	 */
	it('reseals the key set without the named key, under the next version', async () => {
		seed(FOUR)

		await expect(funKeygripRetire(ADMIN, 'k2')).resolves.toBeUndefined()

		const w = written()

		expect(w.key).toBe('test:keygrip')
		expect(w.channel).toBe('test:keygrip:rotated')
		expect(w.expected).toBe('3')
		expect(w.next).toBe('4')

		const keys = unwrapKeygripKeys(w.wrapped, 4, KEK)

		expect(keys.map((k) => k.id)).toEqual(['k4', 'k3', 'k1'])
		expect(keys).toEqual([FOUR[0], FOUR[1], FOUR[3]])
		expect(w.fp).toBe(keygripFingerprint(keys))
		// Retiring is not holding, for the same reason rotating is not: this service signs no cookie.
		expect(hSet).not.toHaveBeenCalled()
	})

	it('records which key was retired, by whom, at which version', async () => {
		seed(FOUR)

		await funKeygripRetire(ADMIN, 'k2')

		const fp = keygripFingerprint(unwrapKeygripKeys(written().wrapped, 4, KEK))

		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(
			`keygrip key k2 retired at version 4 (${fp}) by admin ${sha256Hex(ADMIN.toString())}`,
			'info'
		)
	})

	/*
	 * ⚠️ The same line as `funKeygripRotate`'s, tested separately on purpose: the two writers are the same
	 * decision on the same screen, and a fix applied to one of them is the way this drifts back apart.
	 */
	it('names the admin by digest and never by id', async () => {
		seed(FOUR)

		await funKeygripRetire(ADMIN, 'k2')

		const reported = JSON.stringify(captureMessage.mock.calls)

		expect(reported).toContain(sha256Hex(ADMIN.toString()))
		expect(reported).not.toContain(ADMIN.toString())
	})

	/*
	 * ⚠️ The epic's own line, on the operation that has the strongest reason to break it: an admin
	 * retiring a leaked key is the one most likely to want to see it, and the id is the only part of a key
	 * that may ever be shown.
	 */
	it('puts no key material in the audit event, not even the retired key’s', async () => {
		seed(FOUR)

		await funKeygripRetire(ADMIN, 'k2')

		const reported = JSON.stringify(captureMessage.mock.calls)

		expect(FOUR).toHaveLength(4)
		for (const entry of FOUR) expect(reported).not.toContain(entry.material)
	})

	/*
	 * ⚠️ 404, and the wording matters as much as the status: an admin who read this as "already gone"
	 * would stop responding to a compromise that is still live. Nothing is written, so the answer is
	 * literally "the key set does not contain that, and it is unchanged".
	 */
	it('refuses an id no key carries with a 404, and writes nothing', async () => {
		seed(FOUR)

		const outcome = await rejection(funKeygripRetire(ADMIN, 'k9'))

		// 'Oops' is what every 404 on this platform titles itself — the status and the description are what
		// carry the meaning, which is why `rejection` unpacks all three.
		expect(outcome.message).toBe('Oops')
		expect(outcome.http).toEqual({ status: 404 })
		expect(outcome.description).toBe(
			'KEYGRIP_RETIRE_UNKNOWN: no key in the current set is called k9. Nothing was retired — read the key set again before assuming this key is gone.'
		)
		expect(evalRedis).not.toHaveBeenCalled()
		expect(captureMessage).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ The key at index 0 is what `Keygrip` signs with, so dropping it alone would leave the platform
	 * signing with a key the admin has just declared untrustworthy. 409 rather than 404: the id is real,
	 * the state is what refuses, and the message says rotation is the way out.
	 */
	it('refuses the key the platform signs with, and points at rotation', async () => {
		seed(FOUR)

		const outcome = await rejection(funKeygripRetire(ADMIN, 'k4'))

		expect(outcome.message).toBe('Conflict')
		expect(outcome.http).toEqual({ status: 409 })
		expect(outcome.description).toBe(
			'KEYGRIP_RETIRE_CURRENT: k4 is the key the platform is signing with and cannot be retired on its own. Rotate instead: that mints a fresh signer and moves this key down the array, and it can be retired from there.'
		)
		expect(evalRedis).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ Losing the compare must not be reported as a retire. An admin told "done" about a key that is
	 * still in the record would walk away from a live compromise, so the message says what did not happen
	 * and names the key it did not happen to.
	 */
	it('tells the admin the key is still in use when another write landed first', async () => {
		seed(FOUR)
		evalRedis.mockResolvedValue(0)

		const outcome = await rejection(funKeygripRetire(ADMIN, 'k2'))

		expect(outcome.message).toBe('Conflict')
		expect(outcome.http).toEqual({ status: 409 })
		expect(outcome.description).toBe(
			'The keygrip record changed while k2 was being retired, so nothing was written and that key is still in use. Reload the page and retire it again.'
		)
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('reports a missing record as a 500 carrying what to do about it', async () => {
		hGetAll.mockResolvedValueOnce({})

		const outcome = await rejection(funKeygripRetire(ADMIN, 'k2'))

		expect(outcome.message).toBe('Internal Server Error')
		expect(outcome.http).toEqual({ status: 500 })
		expect(outcome.description).toBe(
			'Error reported to Dev Team.KEYGRIP_RECORD_MISSING: no keygrip key set at "test:keygrip". Run "yarn seed:keygrip" in marketplace-db-setup before starting any service.'
		)
		expect(evalRedis).not.toHaveBeenCalled()
	})

	// The same platform-wide outage `funKeygripRotate` refuses for: resealing under a KEK the five signing
	// services do not have would stop every one of them booting from that moment on.
	it('writes nothing when its own KEK cannot open the record', async () => {
		seed(FOUR, 3, Buffer.alloc(32, 8))

		const outcome = await rejection(funKeygripRetire(ADMIN, 'k2'))

		expect(outcome.message).toBe('Internal Server Error')
		expect(outcome.description).toMatch(
			/^Error reported to Dev Team\.KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 3 \(\w{12}\)\./
		)
		expect(evalRedis).not.toHaveBeenCalled()
		expect(captureMessage).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ Its own counter, not one shared with rotation. Retiring is what an admin does *during* a
	 * suspected compromise, and an afternoon of rotations must not have spent the allowance for the one
	 * write that has to go through.
	 */
	it('meters retirement in a bucket of its own', async () => {
		seed(FOUR)

		await funKeygripRetire(ADMIN, 'k2')

		expect(incr).toHaveBeenCalledExactlyOnceWith(meterKey('retire', '507f1f77bcf86cd799439011'))
	})

	it('refuses the eleventh retirement of the hour without reading the record', async () => {
		incr.mockResolvedValue(KEYGRIP_WRITES_PER_HOUR + 1)

		const outcome = await rejection(funKeygripRetire(ADMIN, 'k2'))

		expect(outcome.message).toBe('Too Many Requests')
		expect(outcome.http).toEqual({ status: 429 })
		expect(hGetAll).not.toHaveBeenCalled()
		expect(evalRedis).not.toHaveBeenCalled()
	})

	// The window is armed by hand because `INCR` on a missing key creates it with no TTL — and repaired on
	// a later call if that `EXPIRE` was ever lost, which would otherwise lock an admin out for good.
	it('arms the hour on a counter that lost its TTL', async () => {
		seed(FOUR)
		incr.mockResolvedValue(2)
		ttl.mockResolvedValue(-1)

		await funKeygripRetire(ADMIN, 'k2')

		expect(expire).toHaveBeenCalledExactlyOnceWith(meterKey('retire', '507f1f77bcf86cd799439011'), KEYGRIP_WRITE_WINDOW_SECONDS)
	})
})

describe('funKeygripStatus', () => {
	it('reads the record and the holders hash, and nothing else', async () => {
		const fp = seedStatus(YOUNG, {})

		const status = await funKeygripStatus()

		expect(status.version).toBe(3)
		expect(status.fingerprint).toBe(fp)
		// Both keys, in order and by name: the holders hash is a second key, and a read that asked the
		// record for it would answer three fields that happen to parse as three services.
		expect(hGetAll.mock.calls).toEqual([['test:keygrip'], ['test:keygrip:holders']])
		expect(hSet).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ Floored, and computed here rather than in the browser. The rotation retires a key at
	 * `SESSION_CAP_DAYS_REMEMBERED` days measured on the server's clock, so a screen that rounded — or that
	 * did this arithmetic against the viewer's clock — would show a key as retirable while the rotation
	 * refuses it, and the admin would be told to retry a button that cannot succeed.
	 */
	it('ages every key against the server clock, floored, so a key on its thirtieth day still reads 29', async () => {
		const keys = [aged('k2', 0), aged('k1', 29)]

		seedStatus(keys, {})

		expect((await funKeygripStatus()).keys).toEqual([
			{ id: 'k2', createdAt: keys[0].createdAt, ageDays: 0 },
			{ id: 'k1', createdAt: keys[1].createdAt, ageDays: 29 }
		])
	})

	/*
	 * ⚠️ The story's own line, and the reason this function reads through `readKeygrip` and then drops what
	 * it unwrapped: no field of the answer carries key material. Asserted against the serialised result, so
	 * a field added to `IKeygripKeyInfo` — or a spread of the raw key — fails here as well as in the schema
	 * test. An admin who could read one key back could mint a session cookie for any account.
	 */
	it('returns no key material anywhere in the answer', async () => {
		const fp = seedStatus(YOUNG, {
			'marketplace-dev-public-authorization': heldAt(keygripFingerprint(YOUNG), '2026-08-12T09:00:00.000Z')
		})

		const reported = JSON.stringify(await funKeygripStatus())

		expect(YOUNG).toHaveLength(2)
		for (const key of YOUNG) expect(reported).not.toContain(key.material)
		expect(reported).toContain(fp)
	})

	/*
	 * The table's whole job: a service that has not caught up yet is *here and behind*, not gone. `current`
	 * is answered against the record this same read returned, so the two cannot be a rotation apart — and
	 * the rows are sorted by service name, because Redis hands hash fields back in an order that is stable
	 * for nobody and a table that reshuffles every poll cannot be read.
	 */
	it('sorts the holders by service and marks the one still signing under an older key set', async () => {
		const fp = keygripFingerprint(YOUNG)

		seedStatus(YOUNG, {
			'marketplace-dev-public-authorization': heldAt(fp, '2026-08-12T09:00:00.000Z'),
			'marketplace-dev-authenticated-logout': heldAt('0123456789ab', '2026-08-12T08:00:00.000Z')
		})

		expect((await funKeygripStatus()).holders).toEqual([
			{
				service: 'marketplace-dev-authenticated-logout',
				fingerprint: '0123456789ab',
				lastSeen: '2026-08-12T08:00:00.000Z',
				current: false
			},
			{
				service: 'marketplace-dev-public-authorization',
				fingerprint: fp,
				lastSeen: '2026-08-12T09:00:00.000Z',
				current: true
			}
		])
	})

	// A fleet that has not booted since the last flush of Redis. `HGETALL` on a missing key answers `{}`,
	// which is a real state and renders as an empty table — not as an error, and not as "all current".
	it('answers an empty holders table rather than failing when nothing has announced itself', async () => {
		seedStatus(YOUNG, {})

		expect((await funKeygripStatus()).holders).toEqual([])
	})

	// The first separator, not the last: the ISO timestamp never carries one, a future fingerprint format
	// might, so an ambiguous row must lose part of its fingerprint rather than its date.
	it('splits a holders row on the first separator', async () => {
		seedStatus(YOUNG, { 'marketplace-dev-authenticated-authorization': 'aa@bb@2026-08-12T09:00:00.000Z' })

		expect((await funKeygripStatus()).holders).toEqual([
			{
				service: 'marketplace-dev-authenticated-authorization',
				fingerprint: 'aa',
				lastSeen: 'bb@2026-08-12T09:00:00.000Z',
				current: false
			}
		])
	})

	// One malformed row must not be the reason an admin cannot see the other five, so a row with no
	// separator at all yields an empty timestamp instead of throwing.
	it('renders a row carrying no timestamp instead of losing the whole table', async () => {
		seedStatus(YOUNG, { 'marketplace-dev-user-authenticated-authorization': 'deadbeefcafe' })

		expect((await funKeygripStatus()).holders).toEqual([
			{
				service: 'marketplace-dev-user-authenticated-authorization',
				fingerprint: 'deadbeefcafe',
				lastSeen: '',
				current: false
			}
		])
	})

	// The same refusal every signing service gives at boot, reached from the screen that exists to show it.
	// The admin's fix is the seed script, and the message carries it.
	it('reports a missing record as a 500 carrying what to do about it', async () => {
		hGetAll.mockResolvedValue({})

		const outcome = await rejection(funKeygripStatus())

		expect(outcome.message).toBe('Internal Server Error')
		expect(outcome.http).toEqual({ status: 500 })
		expect(outcome.description).toBe(
			'Error reported to Dev Team.KEYGRIP_RECORD_MISSING: no keygrip key set at "test:keygrip". Run "yarn seed:keygrip" in marketplace-db-setup before starting any service.'
		)
	})

	/*
	 * ⚠️ This service holding the wrong KEK must surface as an error, never as an empty screen: the record
	 * it cannot open is the one the fleet is signing with, and a status page that answered "no keys, no
	 * holders" would invite the admin to press the button that rewraps it under this service's key —
	 * the platform-wide outage the rotation refuses for the same reason.
	 */
	it('reports a record it cannot open, rather than an empty screen', async () => {
		seedStatus(YOUNG, {}, 3, Buffer.alloc(32, 8))

		const outcome = await rejection(funKeygripStatus())

		expect(outcome.message).toBe('Internal Server Error')
		expect(outcome.http).toEqual({ status: 500 })
		expect(outcome.description).toMatch(
			/^Error reported to Dev Team\.KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 3 \(\w{12}\)\./
		)
	})
})
