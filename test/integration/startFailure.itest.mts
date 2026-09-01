import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import mongoose from 'mongoose'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { start } from '../../src/index.mts'

/*
 * start()'s catch arm — the boot-failure path — driven for real.
 *
 * No fault is simulated: the datasource URL is pointed at something MongoDB genuinely refuses, and
 * the real driver raises the real error. Redis still connects for real on the same Promise.all,
 * which is the point of doing it this way: the catch has to tear down a HALF-CONNECTED process,
 * and disconnectAllDatabases really closes that live Redis client on the way out. initClamScan()
 * never runs in this scenario: Promise.all rejects on MongoDB before start() ever reaches the
 * antivirus step, so this test does not depend on a real clamd socket being reachable.
 *
 * Its own file because it must run with nothing connected yet — index.itest.mts boots the service
 * in its beforeAll, and vitest gives each test file its own module registry, so this one starts
 * from a clean slate.
 */
describe('start() when MongoDB refuses the connection', () => {
	const realUri = process.env.MONGODB_URI

	afterAll(async () => {
		process.env.MONGODB_URI = realUri
		await redisClient.close().catch(() => undefined)
	})

	it('logs, tears down the datasources that did come up, and exits 1', async () => {
		// Shaped like a connection string, so both env guards pass it, and refused by the driver
		// itself, which cannot read `99999` as a port. That keeps the failure where this test wants it —
		// inside MongoDBConnect()'s real driver — and off the two guards, which the tests below own.
		process.env.MONGODB_URI = 'mongodb://127.0.0.1:99999/dbRefused'

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			// Resolves rather than throwing: the catch handles the error and (normally) exits.
			await expect(start()).resolves.toBeUndefined()

			expect(errorLog).toHaveBeenCalled()
			expect(exit).toHaveBeenCalledWith(1)

			// The teardown was real, not just attempted: mongoose never came up and the Redis client
			// that did is closed again.
			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
			errorLog.mockRestore()
		}
	})

	/*
	 * The env guard runs OUTSIDE start()'s try, so a missing variable is not caught, not reported
	 * to Sentry, and never reaches disconnectAllDatabases — it propagates straight out of start()
	 * and the process dies without touching a datasource. Driven through start() rather than by
	 * calling checkRequiredEnv() directly, so it is that ordering being tested and not just the
	 * guard's own loop.
	 *
	 * KEYGRIP_KEK is the entry deleted, and it is the LAST of the list, so a mutant that stops the loop
	 * one short fails here as well as in the unit suite. Any entry would prove the ordering — checkRequiredEnv
	 * throws on the first one it finds missing regardless of position, and every other entry is still
	 * present from the real .env. It used to delete PLATFORM_NAME, which left REQUIRED_ENV_VARS as read
	 * by nothing: the boot then stopped minding its absence and this test reached the real MongoDB
	 * instead of refusing.
	 *
	 * checkRequiredEnv here raises via throwInternalError (a GraphQLError, http 500), not `new
	 * Error` like the authorization services — the client-facing message stays generic while the
	 * missing variable name travels in extensions.description.
	 */
	it('refuses to boot at all, and connects nothing, when a required variable is missing', async () => {
		const realValue = process.env.KEYGRIP_KEK
		delete process.env.KEYGRIP_KEK

		try {
			await expect(start()).rejects.toThrow('Internal Server Error')

			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			process.env.KEYGRIP_KEK = realValue
		}
	})
})
