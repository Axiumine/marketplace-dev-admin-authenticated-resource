import { createHash, randomUUID } from 'node:crypto'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import { ENCRYPTED_FIELDS_ADMIN, KEY_ALT_NAME_ADMIN } from '@axiumine/marketplace-common/encryption/encryptedFields'
import { unwrapKeygripKeys } from '@axiumine/marketplace-common/encryption/unwrapKeygripKeys'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { indexSession, sessionIndexKey, sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Same belt-and-suspenders load as index.itest.mts: the Redis parameters come from `.env`.
dotenv.config()

import { ENDPOINT } from '../../src/index.mts'
import { ITEST_REDIS_KEY, itestKeygripKeys } from '../../vitest.keygrip.mts'
import { bootServer } from './bootServer.mts'

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
 * Redis key — version 1 → 2 → 3, and 4 once the retirement block at the bottom takes a key back out — so
 * each test starts from what the previous one wrote, exactly as the mutation does in production. vitest
 * runs a file's tests sequentially; do not add `concurrent`.
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
/**
 * The record `globalSetup` sealed, spelled from the same ages it used.
 *
 * ⚠️ Read once here rather than called at each assertion: the stamps come from the run's epoch, which the
 * worker inherits through the environment, and a second call must answer the same two strings the seeder
 * wrapped — so the value is pinned where a reader can see that it is one value, not two computations.
 */
const SEEDED_KEYS = itestKeygripKeys()

const KEYGRIP_KEY = `${ITEST_REDIS_KEY}keygrip`
const HOLDERS_KEY = `${ITEST_REDIS_KEY}keygrip:holders`
const ROTATED_CHANNEL = `${ITEST_REDIS_KEY}keygrip:rotated`

/** The KEK globalSetup minted for this run and exported through the environment the workers inherit. */
const KEK = Buffer.from(process.env.KEYGRIP_KEK as string, 'base64')

let httpServer: Server
let base: string
let subscriber: { subscribe(channel: string, listener: (message: string) => void): Promise<unknown>; close(): Promise<unknown> }
const seededKeys: string[] = []

/** Every admin document this run inserted, dropped in `afterAll` while the connection is still open. */
const seededAdmins: mongoose.Types.ObjectId[] = []

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

/**
 * A session in Redis, in the shape a real login writes — `tier` included, or the guard answers 403.
 *
 * ⚠️ **A fresh admin id every call, and its rate-limit counters registered before the seed.** The two
 * write mutations meter per admin per hour, so a shared id would make each test spend the
 * next one's allowance and the suite would start failing at whatever length it happened to reach. The
 * counter keys are pushed ahead of the `hSet` for the reason the session key is: a seed that throws
 * halfway still has to leave `afterAll` something to drain.
 */
async function withSession(tier: string = TIER.admin) {
	const token = `access:${randomUUID()}`
	const key = sessionKey(token)
	const _id = new mongoose.Types.ObjectId().toHexString()

	seededKeys.push(key)
	for (const operation of ['rotate', 'retire'])
		seededKeys.push(`${ITEST_REDIS_KEY}rl:keygrip:${operation}:${createHash('sha256').update(_id).digest('hex')}`)

	await redisClient.hSet(key, { _id, email: 'admin@marketplace.test', tier })

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
	const booted = await bootServer()
	httpServer = booted.httpServer
	base = booted.base

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

	for (const _id of seededAdmins) {
		try {
			await mongoose.connection.db?.collection('admin').deleteOne({ _id })
		} catch (error) {
			console.error(`[afterAll] cleanup failed for admin ${_id.toString()}:`, error)
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
		expect(record.keys).toEqual(SEEDED_KEYS)
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
		expect(record.keys.slice(1)).toEqual(SEEDED_KEYS)
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
	 * admin deciding whether a rotation has landed everywhere. This service signs nothing, so a row for
	 * it would be a service that never adopts anything and never stops looking stale — which is why
	 * `funKeygripRotate` reads through `readKeygrip` and not `loadKeygrip`. Nothing else in this suite
	 * writes to the table, so an empty one is the whole claim.
	 */
	it('never announces itself as a holder of the keys it rotates', async () => {
		expect(await redisClient.hGetAll(HOLDERS_KEY)).toEqual({})
	})
})

/*
 * `keygripStatus` over the same wire and the same record (ADR-034).
 *
 * ⚠️ **Last in the file, and not by accident.** The holders test above claims an empty table, and the
 * tests below write rows into it. vitest runs a file's tests in order; moving this block up would make
 * that claim pass or fail on which suite ran first.
 */
describe('keygripStatus over HTTP, against the record three rotations left behind', () => {
	const STATUS_QUERY = `query {
		keygripStatus {
			version
			fingerprint
			keys { id createdAt ageDays }
			holders { service fingerprint lastSeen current }
		}
	}`

	type StatusPayload = {
		version: number
		fingerprint: string
		keys: Array<{ id: string; createdAt: string; ageDays: number }>
		holders: Array<{ service: string; fingerprint: string; lastSeen: string; current: boolean }>
	}

	/*
	 * ⚠️ Reading the key set is a privileged act, not a public one — the ids and the dates say when the
	 * fleet last rotated and how close a key is to retirement, which is reconnaissance for the one attack
	 * this design exists to make loud. 412 is the bearer gate, ahead of the schema.
	 */
	it('refuses an unauthenticated read of the key set', async () => {
		const { status, json } = await gql(STATUS_QUERY)

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})

	it('answers the live record, and carries no key material in the response body', async () => {
		const headers = await withSession()
		const record = await readRecord()

		const { status, json } = await gql(STATUS_QUERY, headers)

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()

		const payload = json.data?.keygripStatus as StatusPayload

		expect(payload.version).toBe(3)
		expect(payload.fingerprint).toBe(record.fp)
		expect(payload.keys.map((key) => key.id)).toEqual(['k4', 'k3', 'k2', 'k1'])
		expect(payload.keys.map((key) => key.createdAt)).toEqual(record.keys.map((key) => key.createdAt))

		// ⚠️ The story's own line, on the bytes that leave the process: the four keys are in this record and
		// none of them is in this answer. Checked against the material actually sealed in Redis, so a field
		// leaking it under any name — or a stringified key reaching the wire — fails here.
		const body = JSON.stringify(json)

		expect(record.keys).toHaveLength(4)
		for (const key of record.keys) expect(body).not.toContain(key.material)
	})

	/*
	 * Ages, asserted as differences rather than as numbers: the two seeded keys carry fixed dates ten days
	 * apart, so any absolute assertion would make this file expire on a calendar. The pair the rotations
	 * just minted is what pins the floor — both were created seconds ago and must read 0, which a `+` for
	 * `-` or a `*` for `/` in the arithmetic cannot survive.
	 */
	it('reports each key its age in whole days', async () => {
		const headers = await withSession()

		const { json } = await gql(STATUS_QUERY, headers)
		const ages = Object.fromEntries((json.data?.keygripStatus as StatusPayload).keys.map((key) => [key.id, key.ageDays]))

		expect(ages.k4).toBe(0)
		expect(ages.k3).toBe(0)
		expect(ages.k1 - ages.k2).toBe(10)
	})

	/*
	 * The question the screen exists to answer: has the rotation landed everywhere yet. One service on the
	 * current fingerprint, one still on the record it read before the first rotation — and the table comes
	 * back sorted by service name, not in the order Redis happens to hold the hash fields.
	 */
	it('marks a service still signing under an older key set as not current', async () => {
		const headers = await withSession()
		const record = await readRecord()

		seededKeys.push(HOLDERS_KEY)
		await redisClient.hSet(HOLDERS_KEY, 'marketplace-dev-public-authorization', `${record.fp}@2026-08-12T09:00:00.000Z`)
		await redisClient.hSet(HOLDERS_KEY, 'marketplace-dev-authenticated-logout', `0123456789ab@2026-08-12T08:00:00.000Z`)

		const { json } = await gql(STATUS_QUERY, headers)

		expect((json.data?.keygripStatus as StatusPayload).holders).toEqual([
			{
				service: 'marketplace-dev-authenticated-logout',
				fingerprint: '0123456789ab',
				lastSeen: '2026-08-12T08:00:00.000Z',
				current: false
			},
			{
				service: 'marketplace-dev-public-authorization',
				fingerprint: record.fp,
				lastSeen: '2026-08-12T09:00:00.000Z',
				current: true
			}
		])
	})

	/*
	 * ⚠️ The absence, asserted against the schema this service is actually serving rather than against the
	 * source it was built from. A field named `material` does not exist to be asked for, so the request is
	 * refused by validation before a resolver runs — which is a stronger statement than "the resolver does
	 * not fill it in", and the one that stays true if somebody later returns the raw record from the lib.
	 */
	it('has no field an admin could ask key material with', async () => {
		const headers = await withSession()

		const { json } = await gql('query { keygripStatus { keys { material } } }', headers)

		expect(json.data).toBeUndefined()
		expect(json.errors?.[0].message).toMatch(/Cannot query field "material" on type "GraphQLKeygripKeyInfo"/)
	})
})

/*
 * `keygripRetire` over the same wire and the same record (ADR-034).
 *
 * ⚠️ **After the two blocks above, for the same reason `keygripStatus` is after the rotations.** This one
 * takes the record to version 4 and leaves the key set three long; the status block asserts version 3 and
 * four ids, so running this first would break it. It is the last thing that touches the record in this file.
 *
 * ⚠️ **Every refusal here is asserted against the record afterwards, not against the message alone.** This
 * is the one mutation on the platform that logs customers out on purpose, and a refusal that answered 409
 * while removing the key would be indistinguishable from a working guard if only the reply were read.
 */
describe('keygripRetire over HTTP, against the record the rotations left at version 3', () => {
	const retire = (id: string) => `mutation { keygripRetire(id: "${id}") }`

	it('refuses an unauthenticated retirement without touching the record', async () => {
		const { status, json } = await gql(retire('k2'))

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')

		const record = await readRecord()

		expect(record.version).toBe(3)
		expect(record.keys).toHaveLength(4)
	})

	/*
	 * ⚠️ Role is which collection you authenticated against (ADR-002), and a live ShopOwner session is a
	 * real credential — the bearer gate has nothing to object to. `assertTier` is the whole defence, and
	 * what it defends is the ability to log every customer on the platform out. 403, and the four keys are
	 * still there.
	 */
	it('refuses a live session that authenticated against another collection', async () => {
		const headers = await withSession(TIER.shopOwner)

		const { status } = await gql(retire('k2'), headers)

		expect(status).toBe(403)

		const record = await readRecord()

		expect(record.version).toBe(3)
		expect(record.keys.map((key: IKeygripKeyMaterial) => key.id)).toEqual(['k4', 'k3', 'k2', 'k1'])
	})

	/*
	 * ⚠️ 404, and it has to be read as "nothing was retired". An admin halfway through a compromise who
	 * read this as "that key is already gone" would stop responding to a key that is still signing cookies,
	 * which is why the description says so in words and why the record is asserted unchanged here.
	 */
	it('answers 404 and writes nothing when no key in the set is called that', async () => {
		const headers = await withSession()

		const { status, json } = await gql(retire('k9'), headers)

		expect(status).toBe(404)
		expect(json.errors?.[0]?.message).toBe('Oops')
		expect(json.errors?.[0]?.extensions?.description).toBe(
			'KEYGRIP_RETIRE_UNKNOWN: no key in the current set is called k9. Nothing was retired — read the key set again before assuming this key is gone.'
		)

		const record = await readRecord()

		expect(record.version).toBe(3)
		expect(record.keys).toHaveLength(4)
	})

	/*
	 * The refusal the story is built around: dropping the key the fleet signs with leaves the platform with
	 * no signer, so it is refused on the whole operation rather than checked and then removed. The message
	 * names rotation, because rotation is what moves a suspect key out of index 0 — after which it can go.
	 */
	it('refuses to retire the key the platform is signing with', async () => {
		const headers = await withSession()

		const { status, json } = await gql(retire('k4'), headers)

		expect(status).toBe(409)
		expect(json.errors?.[0]?.message).toBe('Conflict')
		expect(json.errors?.[0]?.extensions?.description).toBe(
			'KEYGRIP_RETIRE_CURRENT: k4 is the key the platform is signing with and cannot be retired on its own. Rotate instead: that mints a fresh signer and moves this key down the array, and it can be retired from there.'
		)

		const record = await readRecord()

		expect(record.version).toBe(3)
		expect(record.keys[0].id).toBe('k4')
	})

	/*
	 * The incident response itself, end to end. The suspect key is gone from the bytes Redis holds — asserted
	 * on the material and not only on the ids, because a key left in the array under a changed id would still
	 * verify every cookie it signed — the two innocent keys are untouched, and the version reaches the channel
	 * so the fleet drops it now rather than within five minutes.
	 */
	it('drops the named key from the record and tells the fleet', async () => {
		const headers = await withSession()
		const before = await readRecord()
		const retired = before.keys.find((key: IKeygripKeyMaterial) => key.id === 'k2') as IKeygripKeyMaterial

		const { status, json } = await gql(retire('k2'), headers)

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data?.keygripRetire).toBe(true)

		const record = await readRecord()

		expect(record.version).toBe(4)
		expect(record.keys.map((key: IKeygripKeyMaterial) => key.id)).toEqual(['k4', 'k3', 'k1'])
		expect(record.keys.map((key: IKeygripKeyMaterial) => key.material)).not.toContain(retired.material)
		expect(record.keys).toEqual(before.keys.filter((key: IKeygripKeyMaterial) => key.id !== 'k2'))
		expect(record.fp).toBe(keygripFingerprint(record.keys))
		expect(await publishedVersion('4')).toBe(true)
	})

	/*
	 * ⚠️ The metering, on the path that matters most: eleven attempts from one admin inside the hour, and
	 * the eleventh is refused before the record is read. The first ten name a key that does not exist, so
	 * every one of them is a refusal too — which is the point. A limiter that only counted successful writes
	 * would let a loop guess ids at line speed, and the ids are what `keygripStatus` will not show an
	 * unprivileged caller.
	 */
	it('refuses the eleventh retirement of the hour from one admin', async () => {
		const headers = await withSession()

		for (let attempt = 0; attempt < 10; attempt++) expect((await gql(retire('k9'), headers)).status).toBe(404)

		const { status, json } = await gql(retire('k9'), headers)

		expect(status).toBe(429)
		expect(json.errors?.[0]?.message).toBe('Too Many Requests')

		const record = await readRecord()

		expect(record.version).toBe(4)
	})
})

/*
 * The other half of a retirement, and the one that closes R47.
 *
 * Dropping a key stops it verifying only once each signing service has adopted the new record — 8 ms
 * measured, five minutes if the nudge is lost — and until then a lagging service still accepts the cookies
 * the retired key signed. So the retirement ends the sessions themselves: the lagging service verifies a
 * signature it still accepts, looks the session up, and finds nothing.
 *
 * ⚠️ **Only an integration test can prove this happened.** The sweep reads ids out of three collections and
 * deletes keys in Redis; against mocks it can be wrong in the one way that matters and still look right — a
 * query that selects nothing, or an index key spelled from the wrong tier, reports the same success as a
 * sweep with nothing to do. Here the account is a real document behind the real validator, the session is
 * filed by `indexSession` rather than by a hand-written `hSet`, and the assertion is that the keys are gone
 * from the cluster.
 */
describe('a retirement ends every live session, not only the cookies the key signed', () => {
	const retire = (id: string) => `mutation { keygripRetire(id: "${id}") }`

	/**
	 * One real admin document. The sweep walks the three account collections for ids, so a session filed
	 * under an id nothing holds would be swept by nobody — the document *is* the fixture.
	 *
	 * The password is filler rather than a bcrypt hash: nothing here authenticates as this admin, and the
	 * validator asks only for 60 characters.
	 */
	async function seedAdminAccount() {
		const _id = new mongoose.Types.ObjectId()

		seededAdmins.push(_id)
		await mongoose.connection.db?.collection('admin').insertOne(
			await encryptDocument(
				{
					_id,
					login: { email: `itest-keygrip-${randomUUID()}@marketplace.invalid`, password: 'x'.repeat(60) },
					personalData: { firstName: 'Itest', lastName: 'Keygrip' }
				},
				ENCRYPTED_FIELDS_ADMIN,
				KEY_ALT_NAME_ADMIN
			)
		)

		return _id
	}

	/**
	 * A session as a login leaves it: an access hash, a refresh hash naming it under `accessKey`, and the
	 * index entry that is the only way anything can find either again (BCON-08 bans `SCAN`).
	 *
	 * ⚠️ `indexSession` writes the index, never a literal `hSet`: the field is the digest of the prefixed
	 * token, and a hand-spelled one would let a sweep looking in the wrong place pass this test.
	 */
	async function seedFiledSession(_id: mongoose.Types.ObjectId) {
		const refreshToken = `refresh:${randomUUID()}`
		const accessToken = `access:${randomUUID()}`
		const refreshKey = sessionKey(refreshToken)
		const accessKey = sessionKey(accessToken)
		const index = sessionIndexKey(TIER.admin, _id.toHexString())
		const refreshData = {
			_id: _id.toHexString(),
			tier: TIER.admin,
			familyId: randomUUID(),
			originalLogin: `${Date.now()}`,
			sessionCapDays: '1',
			accessKey
		}

		seededKeys.push(refreshKey, accessKey, index)
		await redisClient.hSet(accessKey, { _id: _id.toHexString(), email: 'itest@marketplace.test', tier: TIER.admin })
		await redisClient.hSet(refreshKey, refreshData)
		await indexSession(redisClient, refreshToken, refreshData)

		return { refreshKey, accessKey, index }
	}

	/*
	 * ⚠️ **The caller's own session survives here and would not in production**, which is worth saying out
	 * loud so nobody reads this test as the rule. `withSession` seeds a session hash and files it under no
	 * index, because it stands in for a bearer token rather than for a login; a real login indexes itself,
	 * and the admin pressing retire is signed out with everybody else.
	 */
	it('deletes both halves of a filed session and the index that named it', async () => {
		const _id = await seedAdminAccount()
		const { refreshKey, accessKey, index } = await seedFiledSession(_id)

		expect(await redisClient.hGetAll(refreshKey)).not.toEqual({})
		expect(await redisClient.hGetAll(accessKey)).not.toEqual({})
		expect(await redisClient.hGetAll(index)).not.toEqual({})

		const { status, json } = await gql(retire('k3'), await withSession())

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data?.keygripRetire).toBe(true)

		const record = await readRecord()

		expect(record.version).toBe(5)
		expect(record.keys.map((key: IKeygripKeyMaterial) => key.id)).toEqual(['k4', 'k1'])

		// Redis drops a hash when its last field goes, so an empty object is the key being gone.
		expect(await redisClient.hGetAll(refreshKey)).toEqual({})
		expect(await redisClient.hGetAll(accessKey)).toEqual({})
		expect(await redisClient.hGetAll(index)).toEqual({})
	})
})
