import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { retentionSweep } from '@lib/retention/retentionSweep.mjs'
import * as Sentry from '@sentry/node'

/**
 * How often one instance tries to sweep — and, because the lock's TTL is this same number, how often the
 * fleet actually sweeps.
 *
 * Hourly rather than daily. The window it guards is thirty days wide, so the cost of being up to an hour
 * late is nothing, while the cost of a *daily* tick is that a service restarted more often than once a day
 * could go a long time between sweeps. Hourly also keeps each pass small: a day's closures at a time,
 * never a backlog that arrives all at once.
 */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** The single key the fleet's sweeps contend on, under this deployment's own Redis prefix. */
export const retentionLockKey = () => `${process.env.REDIS_KEY}retention:lock`

/**
 * The one Redis verb this needs, written out rather than called on `redisClient` directly.
 *
 * `redisClient` is a union of the cluster and single-node clients, and calling a method on a union of two
 * generic signatures is not callable in TypeScript even when both members have it — the same reason
 * `keygripCas.mts` declares `IKeygripCasStore`. Narrowing to the shape actually used says what this file
 * does with Redis — one conditional write, on one key — more honestly than a cast to either client would.
 */
export interface IRetentionLockStore {
	set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>
}

/**
 * Takes the lock, sweeps if it got it, and never lets either throw reach the interval.
 *
 * ⚠️ **`SET NX PX`, and the lock is never released** (ADR-041). Its TTL is the sweep interval, so the key
 * survives until the next tick is due and exactly one instance in the fleet sweeps per interval. Releasing
 * it at the end would reintroduce the classic unlock-ownership race — an instance whose sweep outran the
 * TTL would delete a lock a *different* instance had since taken — and buy nothing, because there is no
 * hurry to sweep again. An instance that dies mid-sweep costs at most one skipped interval; the documents
 * it did not reach are still selected by the next run, since `scrubbedAt` is stamped per document.
 *
 * ⚠️ **`null` means somebody else holds it, and that is a normal result, not a failure.** Every instance
 * ticks; all but one lose, every hour, for ever. Reporting that would drown the real thing this job has to
 * report.
 *
 * ⚠️ **The counts are logged unconditionally, including the zeroes.** The line is the only evidence the job
 * is alive at all — ADR-041 gives up the guarantee that erasure cannot fail to run, and what replaces it is
 * this line in the container's own logs. A `if (count) log()` would make a sweeper that has silently
 * stopped indistinguishable from one with nothing to do, which is the exact failure mode the ADR names.
 *
 * The catch is the whole error boundary: this runs on a timer with nobody awaiting it, so an escaping
 * rejection would reach `process.on('unhandledRejection')` at best and be invisible at worst.
 */
export async function runLockedSweep(now: Date = new Date()): Promise<void> {
	try {
		const store = redisClient as unknown as IRetentionLockStore

		const held = await store.set(retentionLockKey(), now.toISOString(), { NX: true, PX: SWEEP_INTERVAL_MS })

		if (held === null) return

		const { shopOwner, user } = await retentionSweep(now)

		console.info(`retention sweep: scrubbed ${shopOwner} shopOwner and ${user} user account(s)`)
	} catch (error) {
		Sentry.captureException(error)
	}
}

/**
 * Arms the day-30 scrub for the lifetime of this process (ADR-041).
 *
 * ⚠️ **One sweep immediately, then one per interval.** Without the first call, an instance restarted more
 * often than `SWEEP_INTERVAL_MS` would never reach a tick, and erasure would stop while every deploy looked
 * healthy. It is not awaited: boot must not wait on a background job, and `runLockedSweep` already swallows
 * its own failures.
 *
 * ⚠️ **`.unref()`, so the timer never holds the process open.** A referenced interval would keep Node alive
 * after `gracefulShutdown` has drained Apollo and closed the socket, turning every SIGTERM into a wait for
 * the container runtime's kill timeout.
 */
export function startRetentionSweeper(): NodeJS.Timeout {
	void runLockedSweep()

	return setInterval(() => void runLockedSweep(), SWEEP_INTERVAL_MS).unref()
}
