import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const set = vi.fn()
const retentionSweep = vi.fn()
const captureException = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { set } }))
vi.mock('@lib/retention/retentionSweep.mjs', () => ({ retentionSweep }))
vi.mock('@sentry/node', () => ({ captureException }))

const { SWEEP_INTERVAL_MS, retentionLockKey, runLockedSweep, startRetentionSweeper } =
	await import('../src/lib/retention/startRetentionSweeper.mts')

const NOW = new Date('2026-08-29T10:00:00.000Z')

/** The prefix the unit project pins in `vitest.config.mts`, so the key under test is a real one. */
const REDIS_KEY = 'test:'

let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	set.mockReset().mockResolvedValue('OK')
	retentionSweep.mockReset().mockResolvedValue({ shopOwner: 0, user: 0 })
	captureException.mockReset()
	info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
	info.mockRestore()
	vi.useRealTimers()
})

describe('SWEEP_INTERVAL_MS', () => {
	/*
	 * ⚠️ This number is the lock's TTL as well as the tick, and the two must stay the same value —
	 * that identity is what lets the lock be taken and never released. A TTL shorter than the tick
	 * would let two instances sweep in one period; longer, and the fleet would skip periods.
	 */
	it('is one hour, and is the same number the lock expires after', () => {
		expect(SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000)
	})
})

describe('retentionLockKey', () => {
	/*
	 * Under the deployment's own prefix, like every other key this platform writes: two services
	 * sharing a Redis with no prefix would contend on one lock and only one of them would ever sweep.
	 */
	it('lives under the configured keyspace prefix', () => {
		expect(retentionLockKey()).toBe(`${REDIS_KEY}retention:lock`)
	})
})

describe('runLockedSweep', () => {
	/*
	 * ⚠️ The exact options object. `NX` is what makes this a lock at all — without it every instance
	 * in the fleet sweeps every hour — and `PX` is what makes it self-releasing, since nothing ever
	 * deletes this key. A mutant dropping either leaves a call that still succeeds against Redis.
	 */
	it('takes the lock with SET NX PX, stamped with the instant it is sweeping for', async () => {
		await runLockedSweep(NOW)

		expect(set).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}retention:lock`, NOW.toISOString(), {
			NX: true,
			PX: SWEEP_INTERVAL_MS
		})
	})

	it('hands the sweep the same instant it locked with, so selection and stamping share one clock', async () => {
		await runLockedSweep(NOW)

		expect(retentionSweep).toHaveBeenCalledExactlyOnceWith(NOW)
	})

	/*
	 * The default argument is the production path — `startRetentionSweeper` calls this with nothing —
	 * so it needs a case of its own, and one that proves the default is read once rather than twice.
	 */
	it('sweeps for the current instant when called with no argument', async () => {
		await runLockedSweep()

		const stamped = set.mock.calls[0][1]

		expect(new Date(stamped).toISOString()).toBe(stamped)
		expect(retentionSweep.mock.calls[0][0].toISOString()).toBe(stamped)
	})

	it('reports what it scrubbed', async () => {
		retentionSweep.mockResolvedValue({ shopOwner: 3, user: 7 })

		await runLockedSweep(NOW)

		expect(info).toHaveBeenCalledExactlyOnceWith('retention sweep: scrubbed 3 shopOwner and 7 user account(s)')
	})

	/*
	 * ⚠️ The zeroes are logged too, on purpose. ADR-041 gives up the guarantee that erasure cannot fail
	 * to run, and this line is what replaces it: a sweeper that has silently stopped and a sweeper with
	 * nothing to do must not look the same in the logs.
	 */
	it('reports a pass that found nothing, rather than staying silent', async () => {
		await runLockedSweep(NOW)

		expect(info).toHaveBeenCalledExactlyOnceWith('retention sweep: scrubbed 0 shopOwner and 0 user account(s)')
	})

	/*
	 * ⚠️ Losing the lock is the normal outcome, not an error: every instance ticks, all but one lose,
	 * every hour, for ever. It must not sweep, must not log, and must not reach Sentry — a report here
	 * would bury the one thing this job has to report.
	 */
	it('does nothing at all when another instance already holds the lock', async () => {
		set.mockResolvedValue(null)

		await runLockedSweep(NOW)

		expect(retentionSweep).not.toHaveBeenCalled()
		expect(info).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ The catch is the entire error boundary. Nothing awaits this — it runs on a timer — so a throw
	 * that escaped would land on `unhandledRejection` at best and vanish at worst, and the interval
	 * would go on ticking with nobody aware that erasure had stopped. Both sides can throw: Redis is a
	 * network call and the sweep is a long series of writes against a validated collection.
	 */
	it.each([
		{ name: 'Redis is unreachable', arm: () => set.mockRejectedValue(new Error('redis down')) },
		{ name: 'a document is refused by the validator', arm: () => retentionSweep.mockRejectedValue(new Error('validation')) }
	])('reports to Sentry and resolves when $name', async ({ arm }) => {
		arm()

		await expect(runLockedSweep(NOW)).resolves.toBeUndefined()

		expect(captureException).toHaveBeenCalledTimes(1)
	})
})

describe('startRetentionSweeper', () => {
	/*
	 * ⚠️ The immediate sweep is not an optimisation. An instance restarted more often than the interval
	 * — a crash loop, a busy deploy day — would never reach a tick, and erasure would stop while every
	 * deploy looked healthy.
	 */
	it('sweeps once at boot and once per interval after that', async () => {
		vi.useFakeTimers()

		const timer = startRetentionSweeper()

		await vi.advanceTimersByTimeAsync(0)
		expect(retentionSweep).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
		expect(retentionSweep).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
		expect(retentionSweep).toHaveBeenCalledTimes(3)

		clearInterval(timer)
	})

	/*
	 * ⚠️ Real timers here, because the assertion is about a real `Timeout`. A referenced interval would
	 * keep Node alive after `gracefulShutdown` has drained Apollo and closed the socket, turning every
	 * SIGTERM into a wait for the container runtime's kill timeout — and `.unref()` returning the timer
	 * is what makes the dropped call invisible at the call site.
	 */
	it('returns a timer that does not hold the process open', async () => {
		const timer = startRetentionSweeper()

		expect(timer.hasRef()).toBe(false)

		clearInterval(timer)
		await vi.waitFor(() => expect(retentionSweep).toHaveBeenCalledTimes(1))
	})
})
