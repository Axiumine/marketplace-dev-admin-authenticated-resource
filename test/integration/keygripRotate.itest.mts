import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { unwrapKeygripKeys } from '@axiumine/marketplace-common/encryption/unwrapKeygripKeys'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Same belt-and-suspenders load as index.itest.mts: the Redis parameters come from `.env`.
dotenv.config()

import { ENDPOINT, start } from '../../src/index.mts'
import { ITEST_KEYGRIP_KEYS, ITEST_REDIS_KEY } from '../../vitest.keygrip.mts'

/*
 * `keygripRotate` end to end (ADR-034): a real HTTP request, a real admin session in the real Redis
 * cluster, and the record globalSetup sealed under a KEK minted for this run.
 *
 * What only this file can prove, and the unit suite cannot: that the Lua compare-and-set is a script
 * Redis actually accepts and runs, that the version it swaps is the one the seeder wrote, that the blob
 * a second rotation reads back is the one the first left behind, and that the publish reaches a
 * subscriber on the channel name the five signing services will subscribe to. The unit suite mocks
 * `eval` and can only assert the arguments it was handed.
 *
 * ⚠️ **The tests below run in order and share one record.** Rotation is a state machine over a single
 * Redis key — version 1 → 2 → 3 — so each test starts from what the previous one wrote, exactly as the
 * mutation does in production. vitest runs a file's tests sequentially; do not add `concurrent`.
 *
 * Its own file rather than a block in index.itest.mts: that suite counts documents and drains session
 * keys, and this one rewrites the keyspace's keygrip record. Keeping them apart means neither can be
 * read as the cause of the other's failure.
 */

/*
 * The three keys, built from the prefix rather than from `sessionKeys.mts`.
 *
 * ⚠️ Calling the helpers would make this file agree with the source by construction — the assertion
 * "the rotation wrote where the seeder seeded" only means something if the two sides spell the key
 * independently. `ITEST_REDIS_KEY` is what `vitest.config.mts` hands the service as `REDIS_KEY`.
 */
const KEYGRIP_KEY = `${ITEST_REDIS_KEY}keygrip`
const HOLDERS_KEY = `${ITEST_REDIS_KEY}keygrip:holders`
const ROTATED_CHANNEL = `${ITEST_REDIS_KEY}keygrip:rotated`

/** The KEK globalSetup minted for this run and exported through the environment the workers inherit. */
const KEK = Buffer.from(process.env.KEYGRIP_KEK as string, 'base64')

let httpServer: Server
let base: string
let subscriber: { subscribe(channel: string, listener: (message: string) => void): Promise<unknown>; close(): Promise<unknown> }
const seededKeys: string[] = []

/** Every version announced on the channel since the subscription opened, in arrival order. */
const published: string[] = []

/** POST a GraphQL document to the real endpoint and return status + parsed body. */
async function gql(query: string, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query })
	})

	return {
		status: res.status,
		json: (await res.json()) as {
			data?: Record<string, unknown>
			errors?: Array<{ message: string; extensions?: { description?: string } }>
			message?: string
			description?: string
		}
	}
}

/** An admin session in Redis, in the shape a real login writes — `tier` included, or the guard answers 403. */
async function withSession() {
	const token = `access:${randomUUID()}`
	const key = sessionKey(token)

	seededKeys.push(key)
	await redisClient.hSet(key, {
		_id: new mongoose.Types.ObjectId().toHexString(),
		email: 'operator@marketplace.test',
		tier: TIER.admin
	})

	return { authorization: `Bearer ${token}` }
}

/** The record as Redis holds it, opened with this run's KEK. */
async function readRecord() {
	const raw = (await redisClient.hGetAll(KEYGRIP_KEY)) as Record<string, string>
	const version = Number(raw.version)

	return { version, fp: raw.fp, wrapped: raw.wrapped, keys: unwrapKeygripKeys(raw.wrapped, version, KEK) }
}

/**
 * Wait for a version to arrive on the channel.
 *
 * Polling an array rather than racing a one-shot promise: the message is delivered on a socket this
 * process does not drive, so the only honest question is "has it arrived yet", asked until it has or
 * until five seconds say it never will.
 */
async function publishedVersion(version: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (published.includes(version)) return true
		await new Promise((resolve) => setTimeout(resolve, 25))
	}

	return false
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB / clamd')
	httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`

	/*
	 * A second connection, because node-redis refuses ordinary commands on a client in subscriber mode —
	 * the same reason `watchKeygrip` takes the subscriber as a parameter instead of reaching for the
	 * shared client. This one stands in for a signing service listening for rotations.
	 */
	subscriber = redisClient.duplicate()
	await (subscriber as unknown as { connect(): Promise<unknown> }).connect()
	await subscriber.subscribe(ROTATED_CHANNEL, (message) => published.push(message))
})

afterAll(async () => {
	for (const key of seededKeys) {
		try {
			await redisClient.del(key)
		} catch (error) {
			console.error(`[afterAll] cleanup failed for ${key}:`, error)
		}
	}

	// The record itself is deliberately left as this run rotated it: globalSetup deletes and re-seeds it
	// at version 1 before the next run, so restoring it here would only hide a seeder that stopped doing so.
	await subscriber.close().catch(() => undefined)
	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

describe('keygripRotate over HTTP, against the real record', () => {
	/*
	 * ⚠️ First, and asserting the record after: this mutation mints the credentials the whole platform
	 * signs cookies with, so the interesting failure is not "an anonymous caller gets an error" but "an
	 * anonymous caller changed something". 412 is the bearer gate, which runs before the schema is
	 * consulted at all.
	 */
	it('refuses an unauthenticated rotation without touching the record', async () => {
		const { status, json } = await gql('mutation { keygripRotate }')

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')

		const record = await readRecord()

		expect(record.version).toBe(1)
		expect(record.keys).toEqual(ITEST_KEYGRIP_KEYS)
	})

	/*
	 * The story's own line, through the wire: unwrap, mint, prepend, reseal under the bumped version.
	 * The survivors are the assertion that matters — every customer holding a cookie signed under `k2` or
	 * `k1` is still logged in the moment this returns.
	 */
	it('mints a key, keeps the ones still verifying cookies, and files it all under version 2', async () => {
		const headers = await withSession()

		const { status, json } = await gql('mutation { keygripRotate }', headers)

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data?.keygripRotate).toBe(true)

		const record = await readRecord()

		expect(record.version).toBe(2)
		expect(record.keys).toHaveLength(3)
		expect(record.keys[0].id).toBe('k3')
		expect(Buffer.from(record.keys[0].material, 'base64')).toHaveLength(64)
		expect(record.keys.slice(1)).toEqual(ITEST_KEYGRIP_KEYS)
		expect(record.fp).toBe(keygripFingerprint(record.keys))

		// ⚠️ The rollback defence, on the bytes Redis is actually holding: the version is the AAD, so this
		// blob cannot be replayed under the number it replaced by anyone who cannot open it.
		expect(() => unwrapKeygripKeys(record.wrapped, 1, KEK)).toThrow()
	})

	/*
	 * ⚠️ Without this, a rotation is a restart: the five signing services learn about the new key only
	 * when their five-minute poll comes round, and until then index 0 of the fleet disagrees with the
	 * record. The channel name is spelled from `REDIS_KEY` here and from `sessionKeys.mts` in the source —
	 * a subscriber that hears nothing is the two disagreeing.
	 */
	it('announces the new version on the channel the signing services listen to', async () => {
		expect(await publishedVersion('2')).toBe(true)
	})

	/*
	 * The second rotation reads what the first one wrote — which is the only way to find out that the
	 * compare-and-set matched, that the id counter moved on, and that `k3` is still there behind `k4`
	 * rather than having been replaced by a second key minted under the same name.
	 */
	it('rotates again from the record it just wrote, without disturbing what it minted', async () => {
		const headers = await withSession()
		const previous = await readRecord()

		const { json } = await gql('mutation { keygripRotate }', headers)

		expect(json.data?.keygripRotate).toBe(true)

		const record = await readRecord()

		expect(record.version).toBe(3)
		expect(record.keys.map((key: IKeygripKeyMaterial) => key.id)).toEqual(['k4', 'k3', 'k2', 'k1'])
		expect(record.keys.slice(1)).toEqual(previous.keys)
		expect(await publishedVersion('3')).toBe(true)
	})

	/*
	 * ⚠️ The holders table answers "which services are running the current keys", and it is read by an
	 * operator deciding whether a rotation has landed everywhere. This service signs nothing, so a row for
	 * it would be a service that never adopts anything and never stops looking stale — which is why
	 * `funKeygripRotate` reads through `readKeygrip` and not `loadKeygrip`. Nothing else in this suite
	 * writes to the table, so an empty one is the whole claim.
	 */
	it('never announces itself as a holder of the keys it rotates', async () => {
		expect(await redisClient.hGetAll(HOLDERS_KEY)).toEqual({})
	})
})
