import { unwrapKeygripKeys } from '@axiumine/marketplace-common/encryption/unwrapKeygripKeys'
import { wrapKeygripKeys } from '@axiumine/marketplace-common/encryption/wrapKeygripKeys'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const hGetAll = vi.fn()
const evalRedis = vi.fn()
const captureMessage = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGetAll, eval: evalRedis } }))
vi.mock('@sentry/node', () => ({ captureMessage }))

const { funKeygripRotate } = await import('../src/lib/keygrip/funKeygripRotate.mts')

const KEK = Buffer.alloc(32, 7)
const OPERATOR = new Types.ObjectId('507f1f77bcf86cd799439011')
const DAY_MS = 86_400_000

/** `SESSION_CAP_DAYS_REMEMBERED` is 30; a key older than that can no longer be verifying anything. */
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

beforeEach(() => {
	vi.stubEnv('KEYGRIP_KEK', KEK.toString('base64'))
	hGetAll.mockReset()
	evalRedis.mockReset().mockResolvedValue(1)
	captureMessage.mockReset()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('funKeygripRotate', () => {
	it('seals the new key set under the next version and announces it on the channel', async () => {
		seed(YOUNG)

		await expect(funKeygripRotate(OPERATOR)).resolves.toBeUndefined()

		const w = written()

		expect(w.script).toBe(CAS)
		expect(w.key).toBe('test:keygrip')
		expect(w.channel).toBe('test:keygrip:rotated')
		// The version the write is conditional on, and the one it installs. Both, because the pair is the
		// whole concurrency argument: another rotation landing in between moves the first number, and this
		// write then does nothing at all.
		expect(w.expected).toBe('3')
		expect(w.next).toBe('4')
	})

	/*
	 * ⚠️ The one property the fleet depends on: index 0 is what `Keygrip` signs with, and everything after
	 * it is what still verifies. A rotation that reordered or dropped a young key would log out every
	 * customer holding a cookie signed under it.
	 */
	it('prepends a fresh 64-byte key and leaves the ones still verifying cookies untouched', async () => {
		seed(YOUNG)

		await funKeygripRotate(OPERATOR)

		const keys = unwrapKeygripKeys(written().wrapped, 4, KEK)

		expect(keys).toHaveLength(3)
		expect(Buffer.from(keys[0].material, 'base64')).toHaveLength(64)
		expect(keys[0].id).toBe('k3')
		expect(keys.slice(1)).toEqual(YOUNG)
		expect(written().fp).toBe(keygripFingerprint(keys))
	})

	// The retirement half of the same rule, through the real seal: a key nothing can still have been
	// signed with 30 days ago is dropped, so the array does not grow forever.
	it('drops a key that has aged past the longest session this platform issues', async () => {
		seed([aged('k2', 1), aged('k1', AGED_OUT)])

		await funKeygripRotate(OPERATOR)

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

		await funKeygripRotate(OPERATOR)

		expect(() => unwrapKeygripKeys(written().wrapped, 3, KEK)).toThrow()
	})

	it('records who rotated, to what, in the only place this event is written down', async () => {
		seed(YOUNG)

		await funKeygripRotate(OPERATOR)

		const fp = keygripFingerprint(unwrapKeygripKeys(written().wrapped, 4, KEK))

		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(
			`keygrip rotated to version 4 (${fp}) by admin 507f1f77bcf86cd799439011`,
			'info'
		)
	})

	/*
	 * ⚠️ The story's own line, as a test: no path logs, returns or captures key material. The audit event
	 * is the one place tempted to carry it — "which key did we mint?" — and an operator who could read the
	 * material back would be able to mint a session cookie for any account on the platform.
	 */
	it('puts no key material in the audit event, not even the key it just minted', async () => {
		seed(YOUNG)

		await funKeygripRotate(OPERATOR)

		const material = unwrapKeygripKeys(written().wrapped, 4, KEK).map((k) => k.material)
		const reported = JSON.stringify(captureMessage.mock.calls)

		expect(material).toHaveLength(3)
		for (const secret of material) expect(reported).not.toContain(secret)
	})

	/*
	 * ⚠️ Refused, not trimmed: five keys and none of them old enough means every one is still verifying
	 * somebody's cookie, and making room would log those customers out. 409 rather than 500 — the operator
	 * did nothing wrong, the answer is "not yet", and the message says how long.
	 */
	it('refuses a rotation that would retire a key still verifying cookies, and writes nothing', async () => {
		seed([aged('k5', 1), aged('k4', 2), aged('k3', 3), aged('k2', 4), aged('k1', 5)])

		const outcome = await rejection(funKeygripRotate(OPERATOR))

		expect(outcome.message).toBe('Conflict')
		expect(outcome.http).toEqual({ status: 409 })
		expect(outcome.description).toMatch(/^KEYGRIP_ROTATE_CAP: the key set already holds 5 keys and none is older than 30 days\./)
		expect(evalRedis).not.toHaveBeenCalled()
		expect(captureMessage).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ The compare-and-set losing is the case this whole script exists for: two operators, one record.
	 * The loser must be told, and must not report a rotation that never happened — a Sentry line for a
	 * write Redis rejected would be an audit trail that lies.
	 */
	it('tells the operator to retry when another rotation landed first, and claims nothing', async () => {
		seed(YOUNG)
		evalRedis.mockResolvedValue(0)

		const outcome = await rejection(funKeygripRotate(OPERATOR))

		expect(outcome.message).toBe('Conflict')
		expect(outcome.http).toEqual({ status: 409 })
		expect(outcome.description).toBe(
			'The keygrip record changed while this rotation was being prepared, so nothing was written. Another operator rotated a moment ago — reload the page and rotate again if you still need to.'
		)
		expect(captureMessage).not.toHaveBeenCalled()
	})

	// A record nobody has seeded. The operator's fix is the seed script, and the message says so — this
	// is the same refusal every signing service gives at boot, reached from the one service that writes.
	it('reports a missing record as a 500 carrying what to do about it', async () => {
		hGetAll.mockResolvedValueOnce({})

		const outcome = await rejection(funKeygripRotate(OPERATOR))

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

		const outcome = await rejection(funKeygripRotate(OPERATOR))

		expect(outcome.message).toBe('Internal Server Error')
		expect(outcome.description).toMatch(
			/^Error reported to Dev Team\.KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 3 \(\w{12}\)\./
		)
		expect(evalRedis).not.toHaveBeenCalled()
		expect(captureMessage).not.toHaveBeenCalled()
	})
})
