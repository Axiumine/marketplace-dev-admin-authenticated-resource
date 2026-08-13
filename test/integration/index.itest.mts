import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { decryptDocument } from '@axiumine/marketplace-common/encryption/decryptDocument'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import {
	ENCRYPTED_FIELDS_ADMIN,
	ENCRYPTED_FIELDS_COMPANY,
	ENCRYPTED_FIELDS_SHOP_OWNER,
	KEY_ALT_NAME_ADMIN,
	KEY_ALT_NAME_COMPANY,
	KEY_ALT_NAME_SHOP_OWNER
} from '@axiumine/marketplace-common/encryption/encryptedFields'
import { ALGORITHM_DETERMINISTIC } from '@axiumine/marketplace-common/encryption/EncryptionAlgorithm'
import { encryptValue } from '@axiumine/marketplace-common/encryption/fieldEncryption'
import { indexSession, sessionIndexKey, sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { hash, verify } from '@node-rs/bcrypt'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources, handler); this is a
// belt-and-suspenders load so the REDIS_*/MONGODB_URI values are present at this file's top level.
dotenv.config()

import { ENDPOINT, start } from '../../src/index.mts'

const REDIS_KEY = process.env.REDIS_KEY as string
const INTROSPECTION_CODE = process.env.INTROSPECTION_CODE as string

let httpServer: Server
let base: string

/** POST a GraphQL document to the real endpoint and return status + parsed body. */
async function gql(query: string, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query })
	})

	return {
		status: res.status,
		// tdwKoaErrorHandler answers rejected requests with {message, description}; Apollo answers
		// accepted ones with {data, errors}. One parse covers both shapes.
		json: (await res.json()) as {
			data?: Record<string, unknown>
			// `message` on a GraphQL error only ever holds a generic title ('Bad Request', 'Conflict',
			// 'Oops') shared by every failure on the tier; the text that says *which* failure it is
			// travels in `extensions.description`. Asserting the title alone would pass on the wrong
			// error, so the validator cases below read the description Apollo forwards.
			errors?: Array<{ message: string; extensions?: { description?: string } }>
			message?: string
			description?: string
		}
	}
}

/**
 * Seed a real access session on the cluster and hand back both the header and its cleanup.
 * This is the only way in: unlike the authorization tier there is no cookie and no login here,
 * the session is written by public-authorization and read back by this service.
 *
 * The key is also remembered for afterAll: `cleanup()` runs in a `finally`, which does not fire
 * when a seed throws before the `try` — that is how the namespace collected orphan sessions.
 */
async function withSession(email = 'operator@marketplace.test', _id = new mongoose.Types.ObjectId()) {
	const token = `access:${randomUUID()}`
	const key = sessionKey(token)

	seededKeys.push(key)
	// `tier` is what a real login writes and what this service asserts on every request: the auth
	// middleware calls assertTier before ctx.state.user is set, so a tier-less seed is refused with
	// 403 and every test built on this helper fails at the guard instead of reaching its resolver.
	await redisClient.hSet(key, { _id: _id.toHexString(), email, tier: TIER.admin })

	return {
		headers: { authorization: `Bearer ${token}` },
		cleanup: () => redisClient.del(key)
	}
}

/**
 * A live *ShopOwner* session on the cluster: the refresh hash a login writes, plus the entry that login
 * files under the account's session index (E15-S02). What `shopOwnerUpdateStatus` has to be able to end.
 *
 * ⚠️ **`indexSession` writes the index rather than a literal `hSet` here, deliberately.** The field name
 * is the digest of the *prefixed* token and nothing about it is guessable from the outside; spelling it
 * by hand in a test would make this suite pass against a revocation that looks in the wrong place, which
 * is the one failure the story exists to catch. Both keys are registered before the first write, so a
 * throw between them still leaves them drainable in `afterAll` (BCON-09).
 *
 * `sessionCapDays: '1'` because nothing here rotates — the field TTL only has to outlive the test.
 */
async function seedShopOwnerSession(_id: mongoose.Types.ObjectId) {
	const token = `refresh:${randomUUID()}`
	const key = sessionKey(token)
	const index = sessionIndexKey(TIER.shopOwner, _id.toHexString())
	const refreshData = {
		_id: _id.toHexString(),
		tier: TIER.shopOwner,
		familyId: randomUUID(),
		originalLogin: `${Date.now()}`,
		sessionCapDays: '1'
	}

	seededKeys.push(key, index)
	await redisClient.hSet(key, refreshData)
	await indexSession(redisClient, token, refreshData)

	return { key, index }
}

/****************************************************************************************
 * Seeds. The end-to-end reads need MongoDB to actually hold an shopOwner, so they write
 * one to the dev database and delete it again in afterAll. Every document carries an
 * `itest-…@marketplace.invalid` address, and `login.email` is the collection's unique index.
 ****************************************************************************************/

// Nothing on this tier ever verifies a password, so a seeded hash only has to satisfy the
// validator's exactly-60-characters rule.
const PASSWORD_HASH = `$2y$14$${'x'.repeat(53)}`

const seededIds: mongoose.Types.ObjectId[] = []
const seededCompanies: mongoose.Types.ObjectId[] = []
const seededAdmins: mongoose.Types.ObjectId[] = []
const seededKeys: string[] = []

/** The raw driver handle — only defined once start() has connected. */
function db() {
	return mongoose.connection.db!
}

/**
 * A raw read whose ciphertext has been turned back into plaintext (ADR-029).
 *
 * The raw driver is still what reads — the assertions below are about what MongoDB holds, not about
 * what a model would hand back — but a personal field on disk is now a `binData` of subtype 6, so an
 * `expect(...).toBe('an address')` against it can only fail. `decryptDocument` walks whatever it is
 * given and replaces every piece of subtype-6 ciphertext it finds, so it needs no field list and
 * stays right when one changes.
 */
async function decrypted<T>(doc: T): Promise<T> {
	await decryptDocument(doc)

	return doc
}

/**
 * `login.email` as a filter has to be encrypted to match, because the field is stored under the
 * deterministic algorithm — the same plaintext always yields the same ciphertext, which is exactly
 * what makes `$eq` still work, and why the value in the filter has to be the ciphertext too. This is
 * the one place a test filters on an encrypted field; every other read here is by `_id`, `vatNumber`
 * or another field ADR-029 leaves in the clear.
 */
async function shopOwnerEmailFilter(email: string) {
	return { 'login.email': await encryptValue(email, ALGORITHM_DETERMINISTIC, KEY_ALT_NAME_SHOP_OWNER) }
}

/**
 * Inserted with the raw driver rather than the Mongoose model, the platform seeding convention:
 * the insert is then shaped by the collection's own `$jsonSchema` and by nothing else, so a seed
 * cannot inherit whatever the model happens to believe today. That is not hypothetical — the model
 * used to spell `personalData.birth.date` as `date` and carry no `contacts` path at all, both of
 * which the validator refuses under `additionalProperties: false`, so a model write failed outright
 * (fixed in marketplace-common 1.17.0). The raw path was never affected, and will not be by the next
 * drift either.
 *
 * ⚠️ The personal fields go through `encryptDocument` first (ADR-029), because the collection now
 * declares them `binData` and a raw seed of plaintext is rejected by the validator. It runs after
 * `extra` is spread, so a caller overriding `personalData` gets its override encrypted too — the
 * fields that stay in the clear are the three `shopOwnersActiveTbl` sorts and searches on, and those
 * are decided by `ENCRYPTED_FIELDS_SHOP_OWNER` rather than here.
 */
async function seedShopOwner(extra: Record<string, unknown> = {}) {
	const email = `itest-${randomUUID()}@marketplace.invalid`
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('shopOwner')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email, password: PASSWORD_HASH },
					personalData: {
						firstName: 'Itest',
						lastName: 'ShopOwner',
						birth: { date: new Date('1980-01-01T00:00:00Z') },
						address: { street: '1 Test Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
						contacts: { mobile: '3900000000', email }
					},
					registeredAt: new Date(),
					...extra
				},
				ENCRYPTED_FIELDS_SHOP_OWNER,
				KEY_ALT_NAME_SHOP_OWNER
			)
		)
	seededIds.push(_id)

	return { _id, email }
}

/** The seat every seed stores, and the payload shape the address validator answers with. */
const ADDRESS_SEED = {
	street: '1 Test Street',
	postalCode: '01103',
	city: 'Springfield',
	province: 'MA',
	// GeoJSON order: [longitude, latitude]. Plain JS numbers, not Decimal128 —
	// 20260803000000-create-company wants ['double', 'int', 'long'] and rejects decimal, and the
	// collection carries a 2dsphere index that fails the write outright if the two axes are swapped.
	position: { type: 'Point', coordinates: [9.57, 45.75] }
}

/**
 * One company, owned by the shopOwner whose `_id` is passed in.
 *
 * Inserted with the raw driver, same reasoning as seedShopOwner. `vatNumber` and `certifiedEmail` both carry unique
 * indexes — the only unique indexes left anywhere in this chain — and `address.position.coordinates`
 * is validated per axis.
 *
 * The VAT number comes from the shared counter rather than from the id, so the seeded value is one the
 * validator would also accept back: `SHAPE_VAT_NUMBER` is `/^\d{11}$/` and a hex slice is not eleven digits.
 */
async function seedCompany(idShopOwner: mongoose.Types.ObjectId) {
	const _id = new mongoose.Types.ObjectId()
	const legalName = `Itest Boutique ${randomUUID()}`

	await db()
		.collection('company')
		.insertOne(
			await encryptDocument(
				{
					_id,
					idShopOwner,
					legalName,
					vatNumber: vatNumberItest(),
					contactPerson: 'Itest ContactPerson',
					administrator: 'Itest Administrator',
					certifiedEmail: `itest-${_id.toHexString()}@certifiedEmail.invalid`,
					address: ADDRESS_SEED,
					// `published` joined the collection's `required` list in 20260804010000-alter-company-public,
					// so a seed without it is refused by the validator before any resolver is reached. False is
					// the honest value here: these tests exercise the legal entity, not the public shop page, and
					// false is what `companyAdd` writes. `publicName` and `slug` stay off on purpose — the
					// collection's `$expr` demands them only of a published document, and `slug` carries a unique index
					// a fixed literal would collide on.
					published: false,
					registryExtract: 'itest-registryExtract'
				},
				ENCRYPTED_FIELDS_COMPANY,
				KEY_ALT_NAME_COMPANY
			)
		)
	seededCompanies.push(_id)

	return { _id, legalName }
}

/**
 * An 11-digit VAT number, distinct on every call.
 *
 * A literal would collide with itself on the second write of a run, and `vatNumber_unique` is global rather
 * than per shopOwner — so the counter is what lets the same payload be sent twice without the second
 * send failing for a reason the test did not intend.
 */
let vatNumberCounter = 0
function vatNumberItest() {
	return String(90000000000 + ++vatNumberCounter)
}

/**
 * The only seed on this tier that stores a password anyone will ever verify: adminUpdatePwd
 * re-authenticates the caller before it writes. So this one carries a real bcrypt hash of a known
 * plaintext, not the 60 filler characters the shopOwner seeds get away with.
 *
 * Cost 4, not the SALT_ROUNDS 14 the platform hashes at: the cost is baked into the hash string and
 * bcrypt reads it back from there, so a cheap hash still verifies correctly — it just verifies in
 * milliseconds instead of the ~2 s cost 14 costs. What the mutation WRITES is still hashed by the
 * real encryptPassword at 14; only this seed is cheap.
 */
async function seedAdmin(password: string, extra: Record<string, unknown> = {}) {
	const email = `itest-admin-${randomUUID()}@marketplace.invalid`
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('admin')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email, password: await hash(password, 4) },
					personalData: { firstName: 'Itest', lastName: 'Operator' },
					...extra
				},
				ENCRYPTED_FIELDS_ADMIN,
				KEY_ALT_NAME_ADMIN
			)
		)
	seededAdmins.push(_id)

	return { _id, email }
}

/** The stored hash, read straight off the collection — never through the model. */
async function storedAdminHash(_id: mongoose.Types.ObjectId) {
	const doc = await db().collection('admin').findOne({ _id })

	return doc?.login.password as string
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB / clamd')
	httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`
})

/**
 * Cleanup must never abort halfway. `afterAll` drains MongoDB first and Redis second, so a single
 * failed delete — a cluster MOVED mid-resharding, a handle closed early — would otherwise strand
 * every id and key registered after it, and would skip the Redis drain entirely. Mongo residue is
 * harmless, globalSetup drops and re-migrates the database on the next run; a stranded Redis key
 * sits in the cluster for its whole TTL, which for a refresh session is 90 days.
 */
async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

afterAll(async () => {
	// Drop whatever this run created while the handles are still open: documents, then every
	// session key. One del per key — this is a cluster, so a multi-key del would CROSSSLOT.
	for (const _id of seededIds) {
		await drainSafely(`shopOwner ${_id.toString()}`, () => db().collection('shopOwner').deleteOne({ _id }))
	}
	for (const _id of seededCompanies) {
		await drainSafely(`company ${_id.toString()}`, () => db().collection('company').deleteOne({ _id }))
	}
	for (const _id of seededAdmins) {
		await drainSafely(`admin ${_id.toString()}`, () => db().collection('admin').deleteOne({ _id }))
	}
	for (const key of seededKeys) {
		await drainSafely(key, () => redisClient.del(key))
	}

	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

describe('admin-authenticated-resource service (integration, real MongoDB + real Redis cluster)', () => {
	// start() is what wires both datasources and arms ClamAV; asserting the live handles is what
	// makes the rest of this file an integration suite rather than an in-process schema test.
	it('has a live MongoDB connection', () => {
		expect(mongoose.connection.readyState).toBe(1)
	})

	it('has a live Redis cluster connection, round-tripping a key in the isolated namespace', async () => {
		const key = `${REDIS_KEY}ping:${randomUUID()}`

		// EX so this one cannot outlive the run. It is never registered for the afterAll drain, so
		// without a TTL a hard kill — or a throw on the assertion below — strands it on the cluster
		// forever. 60s is far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(key, 'pong', { EX: 60 })
		expect(await redisClient.get(key)).toBe('pong')

		await redisClient.del(key)
		expect(await redisClient.get(key)).toBeNull()
	})
})

describe('bearer-token gate over HTTP', () => {
	it('answers 412 when the request carries no authorization header', async () => {
		const { status, json } = await gql('{ shopOwnersStats }')

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})

	it('answers 499 when the header does not use the `Bearer access:` scheme', async () => {
		const { status, json } = await gql('{ shopOwnersStats }', { authorization: `Bearer ${randomUUID()}` })

		expect(status).toBe(499)
		expect(json.message).toBe('Token Required')
	})

	it('answers 498 when the session is not on the cluster', async () => {
		const { status, json } = await gql('{ shopOwnersStats }', { authorization: `Bearer access:${randomUUID()}` })

		expect(status).toBe(498)
		expect(json.message).toBe('Invalid Token')
	})
})

describe('GraphQL over HTTP', () => {
	// The one request that drives both datasources end to end: Redis authenticates it, MongoDB
	// answers it. No unit test can cover that seam. Counting twice around a seed pins the answer
	// to the real collection — a stubbed or cached count cannot move by exactly one.
	it('counts the shopOwners in the real database for an authenticated admin', async () => {
		const session = await withSession()

		try {
			const before = await gql('{ shopOwnersStats }', session.headers)

			expect(before.status).toBe(200)
			expect(before.json.errors).toBeUndefined()
			expect(typeof before.json.data?.shopOwnersStats).toBe('number')

			await seedShopOwner()

			const after = await gql('{ shopOwnersStats }', session.headers)
			expect(after.json.data?.shopOwnersStats).toBe((before.json.data?.shopOwnersStats as number) + 1)
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * The `$dateToString` bucketing and the `$match` bound, against the real aggregation engine.
	 *
	 * Both halves matter and neither can be seen from a unit test: the mocked `aggregate` in the unit
	 * suite returns whatever the test hands it, so a format string MongoDB rejects, or a `$gte` that
	 * compares a Date against a string, would pass there and fail only here.
	 *
	 * The assertion is a DELTA around two seeds rather than an absolute count, because the suite keeps
	 * inserting shopOwners and the demo seed may have left its own. Today's bucket must gain exactly
	 * one — the document stamped now — while the document stamped two months back must land outside the one-month
	 * range entirely, which is what proves the `$match` bound is real and not decoration.
	 */
	it('buckets the real collection by day and honours the range bound', async () => {
		const session = await withSession()
		const today = new Date().toISOString().slice(0, 10)
		const query = '{ shopOwnersPerPeriod(period: ONE_MONTH) { granularity points { date total } } }'

		try {
			const before = await gql(query, session.headers)

			expect(before.status).toBe(200)
			expect(before.json.errors).toBeUndefined()

			const seriesBefore = before.json.data?.shopOwnersPerPeriod as {
				granularity: string
				points: Array<{ date: string; total: number }>
			}
			expect(seriesBefore.granularity).toBe('DAY')
			// Gap-filled, so today is present whether or not anyone registered today.
			expect(seriesBefore.points.at(-1)?.date).toBe(today)

			await seedShopOwner()
			await seedShopOwner({ registeredAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })

			const after = await gql(query, session.headers)
			const seriesAfter = after.json.data?.shopOwnersPerPeriod as { points: Array<{ date: string; total: number }> }

			expect(seriesAfter.points).toHaveLength(seriesBefore.points.length)
			expect(seriesAfter.points.at(-1)?.total).toBe((seriesBefore.points.at(-1)?.total as number) + 1)

			// The two-month-old seed is outside the range, so nothing else in the series moved.
			const sumBefore = seriesBefore.points.reduce((tot, p) => tot + p.total, 0)
			const sumAfter = seriesAfter.points.reduce((tot, p) => tot + p.total, 0)
			expect(sumAfter).toBe(sumBefore + 1)
		} finally {
			await session.cleanup()
		}
	})

	// The projection in shopOwnerById is long and hand-written; running it against a document
	// this run inserted is the only way to see that it really returns the nested login/personalData
	// shape the operator frontend renders.
	//
	// ⚠️ `notes` is asked for here because it is where that went wrong: the projection spelt the field
	// `note`, Mongoose dropped the unknown token without a word, and the operator note came back `null`
	// for every shop owner who had one — indistinguishable from a shop owner who had none. A seed that
	// stores a note and an assertion that reads it back is what tells those two apart. It also proves
	// the field is decrypted on the way out: `notes` is an encrypted path, so a projection that loaded
	// it without the codec would answer binData rather than the string.
	it('reads a seeded shopOwner back by id, with the projected nested fields', async () => {
		const session = await withSession()
		const { _id, email } = await seedShopOwner({ notes: 'Approved by phone, 2026-03-02.' })

		try {
			const { status, json } = await gql(
				`{ shopOwnerById(idShopOwner: "${_id.toHexString()}") {
					_id login { email onboardingDone } personalData { firstName lastName contacts { email mobile } } waitApprov notes
				} }`,
				session.headers
			)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerById).toEqual({
				_id: _id.toHexString(),
				login: { email, onboardingDone: null },
				personalData: { firstName: 'Itest', lastName: 'ShopOwner', contacts: { email, mobile: '3900000000' } },
				waitApprov: null,
				notes: 'Approved by phone, 2026-03-02.'
			})
		} finally {
			await session.cleanup()
		}
	})

	// shopOwnersActiveTbl filters on `disabled`/`deleted` being absent. Seeding one of each and
	// checking both sides is what proves the filter, rather than a query that happens to return documents.
	//
	// Asked for with no arguments on purpose: the query is now paged, and every argument carries a
	// server-side default. A client that sends nothing must still get a bounded first page — that is
	// what made removing the old unbounded list safe. Both seeds are stamped `registeredAt: new Date()`,
	// so under the default REGISTERED_AT/DESC ordering they are the newest documents and land on page one.
	it('lists the active shopOwners and leaves a disabled one out', async () => {
		const session = await withSession()
		const activeOwner = await seedShopOwner()
		const disabledOwner = await seedShopOwner({ disabled: true })

		try {
			const { json } = await gql('{ shopOwnersActiveTbl { items { _id } total } }', session.headers)

			expect(json.errors).toBeUndefined()
			const page = json.data?.shopOwnersActiveTbl as { items: Array<{ _id: string }>; total: number }
			const ids = page.items.map((doc) => doc._id)
			expect(ids).toContain(activeOwner._id.toHexString())
			expect(ids).not.toContain(disabledOwner._id.toHexString())

			// `total` counts the whole filtered set, not the page — it is what the frontend turns into
			// a page count, so it has to be at least as large as the page it came with.
			expect(page.total).toBeGreaterThanOrEqual(ids.length)
			expect(ids.length).toBeLessThanOrEqual(25)
		} finally {
			await session.cleanup()
		}
	})

	// Search, offset, limit, sort and total, driven together against the real collection. They are
	// one test because they need one shared seed: three documents nothing else in the database can match,
	// which is the only way an assertion about a specific page is stable in a suite that keeps
	// inserting shopOwners. The token is a random prefix no demo document and no other test can start
	// with, so `total` is exactly 3 whatever else the collection holds.
	it('pages, searches and sorts the real collection', async () => {
		const session = await withSession()
		const token = `Zzitest${randomUUID().replace(/-/g, '')}`

		for (const lastName of ['Alfa', 'Beta', 'Gamma']) {
			await seedShopOwner({
				personalData: {
					firstName: token,
					lastName,
					birth: { date: new Date('1980-01-01T00:00:00Z') },
					address: { street: '1 Test Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
					contacts: { mobile: '3900000000', email: `itest-${randomUUID()}@marketplace.invalid` }
				}
			})
		}

		/** Every page below is the same search, so only what changes per call is a parameter. */
		async function page(extra: string) {
			const { json } = await gql(
				`{ shopOwnersActiveTbl(search: "${token}", sortBy: LAST_NAME, ${extra}) {
					items { personalData { lastName } } total
				} }`,
				session.headers
			)
			expect(json.errors).toBeUndefined()
			const result = json.data?.shopOwnersActiveTbl as {
				items: Array<{ personalData: { lastName: string } }>
				total: number
			}

			return { lastNames: result.items.map((doc) => doc.personalData.lastName), total: result.total }
		}

		try {
			// The prefix search really narrows the collection to the three seeds — `total` is the size
			// of the FILTERED set, so anything else here means the search term was ignored.
			const first = await page('limit: 2, sortDir: ASC, offset: 0')
			expect(first).toEqual({ lastNames: ['Alfa', 'Beta'], total: 3 })

			// `total` stays 3 while the page moves: the count is of the filter, not of the slice.
			const second = await page('limit: 2, sortDir: ASC, offset: 2')
			expect(second).toEqual({ lastNames: ['Gamma'], total: 3 })

			// The same index serves the reversed order — asserted here as the reversed page.
			const descending = await page('limit: 2, sortDir: DESC, offset: 0')
			expect(descending).toEqual({ lastNames: ['Gamma', 'Beta'], total: 3 })

			// Past the end is an empty page, not an error: the frontend can land on a stale page
			// number after a shopOwner is deleted, and it has to render an empty table rather than break.
			const past = await page('limit: 2, sortDir: ASC, offset: 100')
			expect(past).toEqual({ lastNames: [], total: 3 })
		} finally {
			await session.cleanup()
		}
	})

	// The ceiling is the whole reason the query is safe to expose: without it a client asks for
	// `limit: 1000000` and pulls the collection through the service in one response. Driven over real
	// HTTP because the 400 has to survive Apollo's error formatting to reach the client as a 400.
	it('refuses a page size past the ceiling, before touching the database', async () => {
		const session = await withSession()

		try {
			const { status, json } = await gql('{ shopOwnersActiveTbl(limit: 101) { total } }', session.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.data?.shopOwnersActiveTbl).toBeUndefined()
		} finally {
			await session.cleanup()
		}
	})

	// `sortBy` becomes a key of the Mongo sort document, so it must not be a free string. GraphQL
	// rejects an unknown enum value at validation time — before any resolver runs, which is what
	// makes "order by an arbitrary field" unreachable rather than merely unimplemented.
	it('rejects an unknown sort column at schema validation', async () => {
		const session = await withSession()

		try {
			const { json } = await gql('{ shopOwnersActiveTbl(sortBy: PASSWORD) { total } }', session.headers)

			expect(json.errors?.[0]?.message).toContain('PASSWORD')
			expect(json.data).toBeUndefined()
		} finally {
			await session.cleanup()
		}
	})

	// infoAdminAfterLogin reads nothing but ctx.state.user, so this proves the Redis hash really
	// became the request context — the makeAuthCtx hop, over HTTP.
	it('echoes the session identity back through infoAdminAfterLogin', async () => {
		const email = `operator-${randomUUID()}@marketplace.test`
		const session = await withSession(email)

		try {
			const { status, json } = await gql('{ infoAdminAfterLogin { _id email } }', session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect((json.data?.infoAdminAfterLogin as { email: string }).email).toBe(email)
		} finally {
			await session.cleanup()
		}
	})

	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	it('exposes the assembled schema to a caller carrying the introspection code', async () => {
		const { status, json } = await gql('{ __schema { queryType { name } mutationType { name } } }', {
			'x-introspectioncode': INTROSPECTION_CODE
		})

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ __schema: { queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } } })
	})

	it('rejects a GET on the GraphQL endpoint (csrfPrevention / method not allowed)', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${base}${ENDPOINT}?query=%7B__typename%7D`, { headers: session.headers })

			expect(res.status).toBeGreaterThanOrEqual(400)
		} finally {
			await session.cleanup()
		}
	})
})

describe('shopOwnerDel mutation (real write, re-read by the raw driver)', () => {
	// funShopOwnerDelete only ever touches `deleted`/`waitApprov` — it never assigns
	// `personalData`, so it does not hit the model/validator mismatch below (see shopOwnerAdd and
	// shopOwnerUpdate). It is the one mutation this suite can drive to a genuinely successful
	// write, and re-reading through the raw driver is what proves the $set/$unset really landed on
	// the server rather than only on a mocked query builder.
	it('soft-deletes a real shopOwner: deleted becomes a real Date, waitApprov is dropped', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner({ waitApprov: true })

		try {
			const { status, json } = await gql(`mutation { shopOwnerDel(_id: "${_id.toHexString()}") }`, session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerDel).toBe(true)

			const updated = await db().collection('shopOwner').findOne({ _id })
			expect(updated?.deleted).toBeInstanceOf(Date)
			expect(updated).not.toHaveProperty('waitApprov')
		} finally {
			await session.cleanup()
		}
	})

	// The other half of funShopOwnerDelete: the server really reports modifiedCount 0, and that
	// is what turns into the 500 — not a mocked updateOne returning a hand-written result object.
	// This is also the only case that drives shopOwnerDel's own catch arm.
	it('answers 500 when the _id matches no shopOwner, and writes nothing', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(`mutation { shopOwnerDel(_id: "${missing.toHexString()}") }`, session.headers)

			// throwInternalError carries an http extension, so this one leaves as a real 500 —
			// unlike the validator-driven failures above, which Apollo answers 200-with-errors.
			expect(status).toBe(500)
			expect(json.errors?.[0]?.message).toBe('Internal Server Error')
			expect(json.data?.shopOwnerDel).toBeUndefined()

			expect(await db().collection('shopOwner').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * Both mutations really write. Two separate bugs used to block every call, and both are fixed —
 * the tests below are the regression guard for each.
 *
 * 1. The shared `ShopOwner` model (marketplace-common) diverged from the collection validator:
 *    `personalData.birth` was spelled `date` rather than `data`, `contacts` had no path at all,
 *    and the inline sub-objects picked up the implicit `_id` Mongoose adds by default. The
 *    migration's real `$jsonSchema` (20260301000100-create-shopOwner.js) declares both
 *    sub-objects under `additionalProperties: false` and requires `birth.date` + `contacts`,
 *    while `GraphQLInputShopOwnerPersonalData` — the wire shape both mutations accept — sends
 *    exactly what the validator wants. Casting through the model therefore dropped `contacts` and
 *    rewrote `birth` to a bare `{ _id }` before anything reached MongoDB, and the server refused
 *    the write. Fixed in marketplace-common 1.17.0, which brought the model back in step.
 *
 * 2. `shopOwnerAdd` handed `create()` a document with no `_id`. Every model in marketplace-common
 *    declares `_id` explicitly and without a default, which switches Mongoose's auto-generation
 *    off, so `create()` threw "document must have an _id before saving" without ever contacting
 *    MongoDB — a failure the first bug hid, since both surfaced as the same generic 500. Fixed by
 *    minting the id in the resolver, the line every other *Add resolver already carried.
 *
 * Both run over real HTTP against the real, migrated, validator-backed collection, so what they
 * assert is the document MongoDB actually accepted — not the one the model claims to emit.
 */
describe('shopOwnerAdd / shopOwnerUpdate mutations', () => {
	it('shopOwnerAdd: creates the shopOwner, birth.date and contacts intact through the real validator', async () => {
		const session = await withSession()
		const email = `itest-${randomUUID()}@marketplace.invalid`
		const before = await db().collection('shopOwner').countDocuments()

		try {
			const { status, json } = await gql(
				`mutation {
					shopOwnerAdd(
						login: { email: "${email}", password: "${PASSWORD_HASH}" }
						personalData: {
							firstName: "Mark"
							lastName: "Rivers"
							birth: { date: "1980-01-01" }
							address: { street: "1 Test Street", postalCode: "01103", city: "Springfield", province: "MA" }
							contacts: { mobile: "3900000000", email: "${email}" }
						}
					)
				}`,
				session.headers
			)

			const created = await decrypted(
				await db()
					.collection('shopOwner')
					.findOne(await shopOwnerEmailFilter(email))
			)
			// Registered before the assertions: the document is already on the real collection, so a
			// failing expect below must still leave afterAll something to delete.
			if (created) seededIds.push(created._id)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerAdd).toBe(true)

			expect(created).not.toBeNull()
			expect(await db().collection('shopOwner').countDocuments()).toBe(before + 1)
			// The two paths the old model mangled, read back off the stored document.
			expect(created?.personalData.birth).toEqual({ date: new Date('1980-01-01T00:00:00.000Z') })
			expect(created?.personalData.contacts).toEqual({ mobile: '3900000000', email })
			// The resolver's own field, and the one that proves `_id` was minted before the insert.
			expect(created?.registeredAt).toBeInstanceOf(Date)
			expect(created?._id).toBeInstanceOf(mongoose.Types.ObjectId)
		} finally {
			await session.cleanup()
		}
	})

	it('shopOwnerUpdate: replaces the seeded personalData, birth.date and contacts included', async () => {
		const session = await withSession()
		const { _id, email } = await seedShopOwner()

		try {
			const { status, json } = await gql(
				`mutation {
					shopOwnerUpdate(
						_id: "${_id.toHexString()}"
						personalData: {
							firstName: "Updated"
							lastName: "Name"
							birth: { date: "1985-06-15" }
							address: { street: "2 New Street", postalCode: "01103", city: "Springfield", province: "MA" }
							contacts: { mobile: "3911111111", email: "${email}" }
						}
					)
				}`,
				session.headers
			)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerUpdate).toBe(true)

			// The whole `personalData` is replaced, so every field is the new one — and the two the old
			// model dropped are present rather than silently missing from a half-cast $set.
			const updated = await decrypted(await db().collection('shopOwner').findOne({ _id }))
			expect(updated?.personalData.firstName).toBe('Updated')
			expect(updated?.personalData.lastName).toBe('Name')
			expect(updated?.personalData.address.street).toBe('2 New Street')
			expect(updated?.personalData.birth).toEqual({ date: new Date('1985-06-15T00:00:00.000Z') })
			expect(updated?.personalData.contacts).toEqual({ mobile: '3911111111', email })
		} finally {
			await session.cleanup()
		}
	})

	// The failure path of the same mutation: when the filter matches NO document, MongoDB writes
	// nothing and the $jsonSchema validator never runs. What answers the 500 here is
	// funShopOwnerUpdate's own `ret.modifiedCount !== 1` guard, driven by a genuine
	// matchedCount: 0 from the server — the same guard, and the same reasoning, as the
	// shopOwnerDel "_id matches no shopOwner" case above.
	it('shopOwnerUpdate: answers 500 via its own modifiedCount guard when the _id matches no shopOwner', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(
				`mutation {
					shopOwnerUpdate(
						_id: "${missing.toHexString()}"
						personalData: {
							firstName: "Ghost"
							lastName: "Owner"
							birth: { date: "1990-01-01" }
							address: { street: "1 Test Street", postalCode: "01103", city: "Springfield", province: "MA" }
							contacts: { mobile: "3922222222", email: "itest-ghost@marketplace.invalid" }
						}
					)
				}`,
				session.headers
			)

			expect(status).toBe(500)
			expect(json.errors?.[0]?.message).toBe('Internal Server Error')
			expect(await db().collection('shopOwner').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * The three field-level writes the detail page needs beyond `shopOwnerUpdate`.
 *
 * What only a live run can prove: that the dotted paths (`login.email`, `login.rememberMe`, …) reach the
 * document without the surrounding sub-object being replaced, that `$unset` really removes the key
 * rather than storing a null the `$jsonSchema` would refuse, and that the unique index on
 * `login.email` — which no mock can raise — comes back as a readable 409 instead of a 500.
 */
describe('shopOwnerUpdateEmail / shopOwnerUpdateStatus / shopOwnerUpdatePreferences mutations', () => {
	/** The `login` sub-document as MongoDB holds it. */
	async function login(_id: mongoose.Types.ObjectId) {
		const doc = await decrypted(await db().collection('shopOwner').findOne({ _id }))

		return doc?.login as Record<string, unknown>
	}

	it('shopOwnerUpdateEmail: replaces login.email and leaves the rest of login untouched', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()
		const newEmail = `itest-new-${randomUUID()}@marketplace.invalid`

		// Seeded through the raw driver so there is something in `login` besides the two required
		// fields: a `{ login: { email } }` write would drop these, a `'login.email'` one keeps them.
		await db()
			.collection('shopOwner')
			.updateOne({ _id }, { $set: { 'login.rememberMe': true, 'login.onboardingStep': 'DATA' } })

		try {
			const { status, json } = await gql(
				`mutation { shopOwnerUpdateEmail(_id: "${_id.toHexString()}", email: "  ${newEmail}  ") }`,
				session.headers
			)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerUpdateEmail).toBe(true)

			// Trimmed on the way in, and the other three keys are still there — `password` included,
			// which is the one whose loss would lock the account out for good.
			expect(await login(_id)).toEqual({
				email: newEmail,
				password: PASSWORD_HASH,
				rememberMe: true,
				onboardingStep: 'DATA'
			})
		} finally {
			await session.cleanup()
		}
	})

	// The collection's only unique index, and the only rejection on this page a valid input can still
	// earn. Driven against the real index because that is the whole point: the helper's `code === 11000`
	// branch is unreachable without one.
	it('shopOwnerUpdateEmail: answers 409 when the address belongs to another shopOwner', async () => {
		const session = await withSession()
		const { _id, email } = await seedShopOwner()
		const otherOwner = await seedShopOwner()

		try {
			const { status, json } = await gql(
				`mutation { shopOwnerUpdateEmail(_id: "${_id.toHexString()}", email: "${otherOwner.email}") }`,
				session.headers
			)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(json.errors?.[0]?.extensions?.description).toBe('email: address already registered by another shopOwner')

			// The rejected write left both documents as they were.
			expect((await login(_id)).email).toBe(email)
			expect((await login(otherOwner._id)).email).toBe(otherOwner.email)
		} finally {
			await session.cleanup()
		}
	})

	// The validator's reason for existing, end to end: without it a malformed address reaches the
	// collection and comes back as `Document failed validation` inside a 500.
	it('shopOwnerUpdateEmail: answers 400 with a readable reason, before touching the database', async () => {
		const session = await withSession()
		const { _id, email } = await seedShopOwner()

		try {
			const { status, json } = await gql(
				`mutation { shopOwnerUpdateEmail(_id: "${_id.toHexString()}", email: "updated@marketplace") }`,
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('email: invalid email address')
			expect((await login(_id)).email).toBe(email)
		} finally {
			await session.cleanup()
		}
	})

	// `matchedCount`, not `modifiedCount` — the same missing id answers a 500 through
	// `shopOwnerUpdate` above, and that divergence is deliberate rather than an oversight.
	it('shopOwnerUpdateEmail: answers 404 when the _id matches no shopOwner', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(
				`mutation { shopOwnerUpdateEmail(_id: "${missing.toHexString()}", email: "itest-ghost@marketplace.invalid") }`,
				session.headers
			)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('shopOwner not found')
		} finally {
			await session.cleanup()
		}
	})

	// Both flags are absent-or-true in the collection, never `false`, so switching one off has to remove
	// the key. A `$set: { disabled: false }` would validate and read back as "not disabled" too — and
	// then `waitApprov: { $exists: true }`, which is how the approval queue is built, would list an
	// account nobody is waiting on.
	it('shopOwnerUpdateStatus: stores both flags, then removes them rather than storing false', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()

		function status(disabled: boolean, waitApprov: boolean) {
			return gql(
				`mutation { shopOwnerUpdateStatus(_id: "${_id.toHexString()}", disabled: ${disabled}, waitApprov: ${waitApprov}) }`,
				session.headers
			)
		}

		try {
			expect((await status(true, true)).json.data?.shopOwnerUpdateStatus).toBe(true)

			const flagsOn = await db().collection('shopOwner').findOne({ _id })
			expect(flagsOn?.disabled).toBe(true)
			expect(flagsOn?.waitApprov).toBe(true)

			expect((await status(false, false)).json.errors).toBeUndefined()

			const flagsOff = await db().collection('shopOwner').findOne({ _id })
			expect(flagsOff).not.toHaveProperty('disabled')
			expect(flagsOff).not.toHaveProperty('waitApprov')
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * E15-S07, end to end on the real cluster: a shop owner parked by an operator loses the sessions they
	 * were holding at that moment.
	 *
	 * ⚠️ **What is asserted is the keyspace, not a refused request, and that is a deviation from the
	 * story's third criterion worth knowing.** The refusal it asks for happens in
	 * `marketplace-dev-authenticated-resource` (4026), which this suite does not boot and cannot: it is
	 * another service, in another repo, with its own database handles. What the two services share is
	 * Redis, so the honest end-to-end assertion available here is that the refresh session and its index
	 * are gone — after which 4026 has nothing left to rotate and the next refresh fails there by
	 * construction. The residual is unchanged and stated in `endEveryShopOwnerSession`: an access token
	 * already minted keeps working until it expires.
	 */
	it('shopOwnerUpdateStatus: parking an account deletes the sessions it was holding, index included', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()
		const { key, index } = await seedShopOwnerSession(_id)

		try {
			// The seed is asserted live first: a revocation that deleted nothing and a seed that wrote
			// nothing leave the same empty keyspace behind, and only this line separates them.
			expect(await redisClient.hGetAll(key)).toMatchObject({ _id: _id.toHexString(), tier: TIER.shopOwner })
			expect(Object.keys(await redisClient.hGetAll(index))).toHaveLength(1)

			const { json } = await gql(
				`mutation { shopOwnerUpdateStatus(_id: "${_id.toHexString()}", disabled: true, waitApprov: false) }`,
				session.headers
			)
			expect(json.data?.shopOwnerUpdateStatus).toBe(true)

			expect(await redisClient.hGetAll(key)).toEqual({})
			expect(await redisClient.hGetAll(index)).toEqual({})
		} finally {
			await session.cleanup()
		}
	})

	// The other half of the rule: approving and enabling an account is not a credential event and must
	// leave whoever is signed in signed in. Nothing revokes on the way out of a parked state.
	it('shopOwnerUpdateStatus: releasing an account leaves its live sessions alone', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner({ disabled: true, waitApprov: true })
		const { key, index } = await seedShopOwnerSession(_id)

		try {
			const { json } = await gql(
				`mutation { shopOwnerUpdateStatus(_id: "${_id.toHexString()}", disabled: false, waitApprov: false) }`,
				session.headers
			)
			expect(json.errors).toBeUndefined()

			expect(await redisClient.hGetAll(key)).toMatchObject({ _id: _id.toHexString(), tier: TIER.shopOwner })
			expect(Object.keys(await redisClient.hGetAll(index))).toHaveLength(1)
		} finally {
			await session.cleanup()
		}
	})

	// The two booleans here behave the *opposite* way to the two above: `login.rememberMe` and
	// `login.onboardingDone` are declared `bool` and are stored as false, while `onboardingStep` is the
	// one optional string and is unset when the operator empties the box.
	it('shopOwnerUpdatePreferences: stores false booleans and unsets a blank onboardingStep', async () => {
		const session = await withSession()
		const { _id, email } = await seedShopOwner()

		function preferences(rememberMe: boolean, onboardingDone: boolean, step?: string) {
			return gql(
				`mutation {
					shopOwnerUpdatePreferences(
						_id: "${_id.toHexString()}"
						rememberMe: ${rememberMe}
						onboardingDone: ${onboardingDone}
						${step === undefined ? '' : `onboardingStep: "${step}"`}
					)
				}`,
				session.headers
			)
		}

		try {
			expect((await preferences(true, false, 'DATA')).json.data?.shopOwnerUpdatePreferences).toBe(true)
			expect(await login(_id)).toEqual({
				email,
				password: PASSWORD_HASH,
				rememberMe: true,
				onboardingDone: false,
				onboardingStep: 'DATA'
			})

			// A cleared text box arrives as blank, not as null, and has to leave the key absent —
			// `login.onboardingStep: null` fails `bsonType: 'string'` and takes the whole save with it.
			expect((await preferences(false, true, '   ')).json.errors).toBeUndefined()
			expect(await login(_id)).toEqual({
				email,
				password: PASSWORD_HASH,
				rememberMe: false,
				onboardingDone: true
			})
		} finally {
			await session.cleanup()
		}
	})

	it('shopOwnerUpdatePreferences: answers 400 for an onboardingStep past the collection cap', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()

		try {
			const { status, json } = await gql(
				`mutation { shopOwnerUpdatePreferences(_id: "${_id.toHexString()}", rememberMe: true, onboardingDone: false, onboardingStep: "TROPPOLUNGO") }`,
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.extensions?.description).toBe('onboardingStep: max 4 characters')
			expect(await login(_id)).not.toHaveProperty('onboardingStep')
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * The `company` collection, created by 20260803000000 and written for the first time here.
 *
 * This is where the two unique indexes live: `vatNumber_unique` and `certifiedEmail_unique`, on the
 * collection where one document really is one company.
 *
 * Both are plain global unique indexes, with no `partialFilterExpression` excluding the soft-deleted —
 * the same shape `shopOwner.login.email_unique` has. That is a decision, not an oversight: a deleted
 * company keeps its VAT number occupied, and the `companyDel` block asserts it.
 */
describe('company mutations (real company collection, real unique indexes)', () => {
	/**
	 * A complete, valid company. Three normalisations are baked into the literal rather than tested
	 * apart: the padded `legalName` (trimmed), the blank `taxCode` and blank `uniqueCode` (dropped, not
	 * stored as ''), and the lower-case `province` (upper-cased). `position` carries coordinates only,
	 * exactly as on the shop form — the input type has no `type` field.
	 */
	function inputCompany(vatNumber: string, certifiedEmail: string, taxCode = '   ', uniqueCode = '   ') {
		return `{
			legalName: "  New Boutique Ltd  "
			vatNumber: "${vatNumber}"
			taxCode: "${taxCode}"
			contactPerson: "New ContactPerson"
			administrator: "New Administrator"
			uniqueCode: "${uniqueCode}"
			certifiedEmail: "${certifiedEmail}"
			address: {
				street: "7 New Street"
				postalCode: "01104"
				city: "Riverside"
				province: "ma"
				position: { coordinates: [9.6, 45.72] }
			}
			registryExtract: "registryExtract-new"
			published: false
		}`
	}

	function addMutation(idShopOwner: string, vatNumber: string, certifiedEmail: string, taxCode?: string, uniqueCode?: string) {
		return `mutation {
			companyAdd(idShopOwner: "${idShopOwner}", company: ${inputCompany(vatNumber, certifiedEmail, taxCode, uniqueCode)})
		}`
	}

	function updateMutation(_id: string, vatNumber: string, certifiedEmail: string, taxCode?: string, uniqueCode?: string) {
		return `mutation { companyUpdate(_id: "${_id}", company: ${inputCompany(vatNumber, certifiedEmail, taxCode, uniqueCode)}) }`
	}

	function certifiedEmailItest() {
		return `itest-company-${randomUUID()}@certifiedEmail.invalid`
	}

	/**
	 * The mutation answers `Boolean!`, so the caller never learns the new id — the company is found by
	 * its VAT number, the one value the index guarantees unique. Registering it here rather than in each
	 * test is what keeps a successful insert from surviving the run: `afterAll` drains `seededCompanies`,
	 * and a document nobody pushed into it stays in the database forever, holding its vatNumber against every
	 * later run.
	 */
	async function created(vatNumber: string) {
		const doc = await db().collection('company').findOne({ vatNumber })

		if (doc !== null) seededCompanies.push(doc._id)

		return doc
	}

	it('companyAdd: writes the company under the named owner, minting the id and dropping the blank optionals', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const vatNumber = vatNumberItest()
		const certifiedEmail = certifiedEmailItest()

		try {
			const { status, json } = await gql(addMutation(owner._id.toHexString(), vatNumber, certifiedEmail), session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.companyAdd).toBe(true)

			const doc = await created(vatNumber)
			expect(doc?.idShopOwner).toEqual(owner._id)
			expect(doc?.legalName).toBe('New Boutique Ltd')
			expect(doc?.address).toEqual({
				street: '7 New Street',
				postalCode: '01104',
				city: 'Riverside',
				province: 'MA',
				position: { type: 'Point', coordinates: [9.6, 45.72] }
			})
			// ⚠️ `taxCode` and `uniqueCode` are ABSENT, not empty. Both were sent blank, and the collection's
			// `additionalProperties: false` plus `bsonType: 'string'` means a cleared box written as null
			// — which is what GraphQL serialises it to — fails the whole insert. The mongoose version key
			// rides along because the model declares it and the validator allows it.
			//
			// ⚠️ The list is in `.sort()` order and has to stay that way. It was written against the
			// pre-rename field names and was never re-sorted afterwards, so it compared a sorted array
			// against an unsorted literal and could only ever fail — which it did, silently folded into
			// the same run's tier failures. `published` belongs here because it is `required` on the
			// collection since 20260804010000-alter-company-public: it is stored, not dropped.
			expect(Object.keys(doc ?? {}).sort()).toEqual([
				'__v',
				'_id',
				'address',
				'administrator',
				'certifiedEmail',
				'contactPerson',
				'idShopOwner',
				'legalName',
				'published',
				'registryExtract',
				'vatNumber'
			])
		} finally {
			await session.cleanup()
		}
	})

	// The other side of the same rule: sent with a value, both optionals land. `taxCode` is the field the
	// extraction added — no stored company predating it carries one — and eleven characters is its only
	// constraint, on the collection and in the validator alike.
	it('companyAdd: stores taxCode and uniqueCode when they carry a value', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const vatNumber = vatNumberItest()

		try {
			const { json } = await gql(
				addMutation(owner._id.toHexString(), vatNumber, certifiedEmailItest(), '12345678901', 'ABC1234'),
				session.headers
			)

			expect(json.errors).toBeUndefined()

			const doc = await created(vatNumber)
			expect(doc?.taxCode).toBe('12345678901')
			expect(doc?.uniqueCode).toBe('ABC1234')
		} finally {
			await session.cleanup()
		}
	})

	// The owner is checked before the write: `shopOwnerCompanies` lists strictly by owner, so a company
	// filed under an id no shopOwner carries is reachable only through the same wrong id that created it.
	it('companyAdd: answers 404 for an owner that does not exist, and writes nothing', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()
		const vatNumber = vatNumberItest()

		try {
			const { status, json } = await gql(addMutation(missing.toHexString(), vatNumber, certifiedEmailItest()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('shopOwner not found')
			expect(await created(vatNumber)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	it('companyAdd: answers 404 for a soft-deleted owner, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedShopOwner({ deleted: new Date() })
		const vatNumber = vatNumberItest()

		try {
			const { status, json } = await gql(addMutation(owner._id.toHexString(), vatNumber, certifiedEmailItest()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.extensions?.description).toBe('shopOwner not found')
			expect(await created(vatNumber)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ Enforced by MongoDB itself, not by a pre-flight read: two operators saving the same VAT number
	 * at once both pass any check the service could make, and only the index refuses the second one. The
	 * second owner is a DIFFERENT shopOwner on purpose — `vatNumber_unique` is global, not per owner.
	 */
	it('companyAdd: answers 409 when the VAT number is already registered, whoever owns it', async () => {
		const session = await withSession()
		const first = await seedShopOwner()
		const secondOwner = await seedShopOwner()
		const vatNumber = vatNumberItest()

		try {
			expect((await gql(addMutation(first._id.toHexString(), vatNumber, certifiedEmailItest()), session.headers)).status).toBe(
				200
			)
			await created(vatNumber)

			const { status, json } = await gql(
				addMutation(secondOwner._id.toHexString(), vatNumber, certifiedEmailItest()),
				session.headers
			)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(json.errors?.[0]?.extensions?.description).toBe(
				'VAT number or certified email already registered by another company'
			)
			expect(await db().collection('company').countDocuments({ vatNumber })).toBe(1)
		} finally {
			await session.cleanup()
		}
	})

	// The second unique index, driven separately: the message names both candidates precisely because the
	// driver's error does not say which one fired, and a test that only ever trips `vatNumber_unique` would
	// leave `certifiedEmail_unique` unproven while the message kept claiming it.
	it('companyAdd: answers 409 when the certified email is already registered', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const certifiedEmail = certifiedEmailItest()
		const firstVatNumber = vatNumberItest()
		const secondVatNumber = vatNumberItest()

		try {
			expect((await gql(addMutation(owner._id.toHexString(), firstVatNumber, certifiedEmail), session.headers)).status).toBe(200)
			await created(firstVatNumber)

			const { status, json } = await gql(addMutation(owner._id.toHexString(), secondVatNumber, certifiedEmail), session.headers)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.extensions?.description).toBe(
				'VAT number or certified email already registered by another company'
			)
			expect(await created(secondVatNumber)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	// The path prefix is `company.` because the fields arrive inside one input object, and the operator
	// reads that path to find the box. `taxCode` is the field to prove it with: it is the one the extraction
	// added, and its rule — exactly eleven characters — is neither a max nor a min alone.
	it('companyAdd: answers 400 naming the prefixed path, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const vatNumber = vatNumberItest()

		try {
			const { status, json } = await gql(
				addMutation(owner._id.toHexString(), vatNumber, certifiedEmailItest(), '1234567890'),
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('company.taxCode: exactly 11 characters')
			expect(await created(vatNumber)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	it('companyUpdate: replaces every editable field in one write, leaving idShopOwner alone', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const company = await seedCompany(owner._id)
		const vatNumber = vatNumberItest()
		const certifiedEmail = certifiedEmailItest()

		try {
			const { status, json } = await gql(updateMutation(company._id.toHexString(), vatNumber, certifiedEmail), session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.companyUpdate).toBe(true)

			const after = await db().collection('company').findOne({ _id: company._id })
			expect(after?.legalName).toBe('New Boutique Ltd')
			expect(after?.vatNumber).toBe(vatNumber)
			expect(after?.certifiedEmail).toBe(certifiedEmail)
			expect(after?.address.city).toBe('Riverside')
			// ⚠️ The owner is not in the `$set` and cannot be: `ICompanyValidata` has no `idShopOwner`
			// and `GraphQLInputCompany` has no field for it. Reassigning a company would strand every shop
			// pointing at it under an shopOwner that no longer owns the company.
			expect(after?.idShopOwner).toEqual(owner._id)
		} finally {
			await session.cleanup()
		}
	})

	it('companyUpdate: answers 409 when the new VAT number belongs to another company', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const otherCompany = await seedCompany(owner._id)
		const company = await seedCompany(owner._id)
		const takenVatNumber = (await db().collection('company').findOne({ _id: otherCompany._id }))?.vatNumber as string

		try {
			const { status, json } = await gql(
				updateMutation(company._id.toHexString(), takenVatNumber, certifiedEmailItest()),
				session.headers
			)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(json.errors?.[0]?.extensions?.description).toBe(
				'VAT number or certified email already registered by another company'
			)

			// Nothing landed: the whole card is one `$set`, so a rejected write leaves the registered legal name
			// and the seat as they were too.
			const unchanged = await db().collection('company').findOne({ _id: company._id })
			expect(unchanged?.legalName).toMatch(/^Itest Boutique /)
			expect(unchanged?.address.street).toBe('1 Test Street')
		} finally {
			await session.cleanup()
		}
	})

	it('companyUpdate: answers 404 when the _id matches no company', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(
				updateMutation(missing.toHexString(), vatNumberItest(), certifiedEmailItest()),
				session.headers
			)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('company not found')
			expect(await db().collection('company').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * A soft delete, like every other delete on this tier: the document stays and gains a `deleted` instant,
	 * and every read path filters it out with `deleted: { $exists: false }`.
	 *
	 * The document itself is asserted whole: `deleted` is a Date the validator accepted — `Date.now()` is a
	 * number in the resolver and only mongoose's cast makes it one — and nothing else moved, which is
	 * what separates a soft delete from an `updateOne` that quietly rewrote the document.
	 */
	it('companyDel: stamps deleted and keeps the document', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const company = await seedCompany(owner._id)

		try {
			const before = new Date()
			const { status, json } = await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.companyDel).toBe(true)

			const after = await db().collection('company').findOne({ _id: company._id })
			expect(after).not.toBeNull()
			expect(after?.deleted).toBeInstanceOf(Date)
			expect((after?.deleted as Date).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
			expect(after?.legalName).toBe(company.legalName)
			expect(after?.idShopOwner).toEqual(owner._id)
		} finally {
			await session.cleanup()
		}
	})

	// The company is gone from every read path the operator has, which is the whole of what "deleted"
	// means here — the document is still on disk and only the seed's own drain will remove it.
	it('companyDel: drops the company out of shopOwnerCompanies', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const live = await seedCompany(owner._id)
		const deadCompany = await seedCompany(owner._id)

		try {
			const { status } = await gql(`mutation { companyDel(_id: "${deadCompany._id.toHexString()}") }`, session.headers)
			expect(status).toBe(200)

			const { json } = await gql(`{ shopOwnerCompanies(idShopOwner: "${owner._id.toHexString()}") { _id } }`, session.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerCompanies).toEqual([{ _id: live._id.toHexString() }])
		} finally {
			await session.cleanup()
		}
	})

	// ⚠️ The VAT number stays taken. Both unique indexes are plain global ones — no
	// `partialFilterExpression` excluding the deleted, the same choice `shopOwner.login.email_unique`
	// makes — so retiring a company does not free its vatNumber for a fresh registration. Asserted rather than
	// left implicit because it is the one user-visible cost of the soft delete, and because adding the
	// partial filter later would flip this case silently.
	it('companyDel: leaves the VAT number registered, so the same one cannot be added again', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const company = await seedCompany(owner._id)
		const vatNumber = (await db().collection('company').findOne({ _id: company._id }))?.vatNumber as string

		try {
			expect((await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)).status).toBe(200)

			const { status, json } = await gql(addMutation(owner._id.toHexString(), vatNumber, certifiedEmailItest()), session.headers)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.extensions?.description).toBe(
				'VAT number or certified email already registered by another company'
			)
			expect(await db().collection('company').countDocuments({ vatNumber })).toBe(1)
		} finally {
			await session.cleanup()
		}
	})

	// A second call finds the document, matches it and stamps it again. There is no `deleted` clause on the
	// write, so this is idempotent in effect, not a 404.
	it('companyDel: answers 200 again on an already deleted company', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const company = await seedCompany(owner._id)

		try {
			expect((await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)).status).toBe(200)

			const { status, json } = await gql(`mutation { companyDel(_id: "${company._id.toHexString()}") }`, session.headers)

			expect(status).toBe(200)
			expect(json.data?.companyDel).toBe(true)
			expect((await db().collection('company').findOne({ _id: company._id }))?.deleted).toBeInstanceOf(Date)
		} finally {
			await session.cleanup()
		}
	})

	it('companyDel: answers 404 when the _id matches no company', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(`mutation { companyDel(_id: "${missing.toHexString()}") }`, session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('company not found')
		} finally {
			await session.cleanup()
		}
	})
})

describe('shopOwnerCompanies query (real company under a real shopOwner)', () => {
	// Every field of the type, over the wire, against the real validator-backed collection: this is the
	// query the shop form's `<select>` is populated from, so a field the resolver fails to project is a
	// box the operator cannot fill. `taxCode` and `uniqueCode` come back null — the seed stores neither, which is
	// exactly the state every company predating the extraction is in.
	it('returns the companies of the shopOwner whose id is passed, and nothing for a foreign id', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const company = await seedCompany(owner._id)

		try {
			const { json } = await gql(
				`{ shopOwnerCompanies(idShopOwner: "${owner._id.toHexString()}") { _id idShopOwner legalName vatNumber taxCode contactPerson administrator uniqueCode certifiedEmail registryExtract address { street postalCode city province position { type coordinates } } } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerCompanies).toEqual([
				{
					_id: company._id.toHexString(),
					idShopOwner: owner._id.toHexString(),
					legalName: company.legalName,
					vatNumber: expect.stringMatching(/^\d{11}$/),
					taxCode: null,
					contactPerson: 'Itest ContactPerson',
					administrator: 'Itest Administrator',
					uniqueCode: null,
					certifiedEmail: `itest-${company._id.toHexString()}@certifiedEmail.invalid`,
					registryExtract: 'itest-registryExtract',
					address: {
						street: '1 Test Street',
						postalCode: '01103',
						city: 'Springfield',
						province: 'MA',
						position: { type: 'Point', coordinates: [9.57, 45.75] }
					}
				}
			])

			// The company's own _id is not an owner id, so the query must find nothing for it — the
			// argument swap this query has to stay immune to.
			const byCompanyOwnId = await gql(
				`{ shopOwnerCompanies(idShopOwner: "${company._id.toHexString()}") { _id } }`,
				session.headers
			)
			expect(byCompanyOwnId.json.errors).toBeUndefined()
			expect(byCompanyOwnId.json.data?.shopOwnerCompanies).toEqual([])
		} finally {
			await session.cleanup()
		}
	})

	// Every company of that owner and no other's, which is what makes the list safe to render as a
	// `<select>`: an entry from another shopOwner would be an option no write of theirs can accept.
	it('lists every company of the owner, and never another owner’s', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const firstCompany = await seedCompany(owner._id)
		const secondCompany = await seedCompany(owner._id)
		const strangerOwner = await seedShopOwner()
		await seedCompany(strangerOwner._id)

		try {
			const { json } = await gql(`{ shopOwnerCompanies(idShopOwner: "${owner._id.toHexString()}") { _id } }`, session.headers)

			expect(json.errors).toBeUndefined()
			expect((json.data?.shopOwnerCompanies as Array<{ _id: string }>).map((a) => a._id).sort()).toEqual(
				[firstCompany._id.toHexString(), secondCompany._id.toHexString()].sort()
			)
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * The one mutation on this tier that writes to the `admin` collection, and the only place a
 * password is verified rather than merely stored. Every case below runs over real HTTP against the
 * real, validator-backed collection, and re-reads the stored hash with the raw driver — the write
 * has to be judged by what MongoDB accepted, not by what the model claims to emit.
 */
describe('adminUpdatePwd mutation (real bcrypt, real admin collection)', () => {
	const OLD = 'oldPassword1'
	const NEW = 'newPassword12'

	/** The mutation takes no id: the account it changes is the one the session names. */
	function updatePwd(passwordOld: string, passwordNew: string, headers: Record<string, string>) {
		return gql(`mutation { adminUpdatePwd(passwordOld: "${passwordOld}", passwordNew: "${passwordNew}") }`, headers)
	}

	it('re-hashes the new password and stores it on the session account', async () => {
		const admin = await seedAdmin(OLD)
		const session = await withSession(admin.email, admin._id)
		const before = await storedAdminHash(admin._id)

		try {
			const { status, json } = await updatePwd(OLD, NEW, session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.adminUpdatePwd).toBe(true)

			const after = await storedAdminHash(admin._id)
			expect(after).not.toBe(before)
			// The plaintext never reaches the collection: what is stored verifies the new password
			// and no longer verifies the old one. `updateOne` bypasses the pre('save') hook that
			// normally hashes, so without the explicit encryptPassword this assertion is what fails —
			// with the cleartext password sitting in MongoDB.
			expect(await verify(NEW, after)).toBe(true)
			expect(await verify(OLD, after)).toBe(false)
			// 60 characters is the collection validator's own min AND max for `login.password`. The
			// write landed, so it passed — asserted anyway, because a hash of any other length would
			// mean the value stored is not a bcrypt hash at all.
			expect(after).toHaveLength(60)
		} finally {
			await session.cleanup()
		}
	})

	// The old password is the re-authentication step. An access token is a bearer credential, so
	// without this a stolen token is permanent ownership of the operator account.
	it('refuses a wrong old password and leaves the stored hash untouched', async () => {
		const admin = await seedAdmin(OLD)
		const session = await withSession(admin.email, admin._id)
		const before = await storedAdminHash(admin._id)

		try {
			const { status, json } = await updatePwd('passwordSbagliata', NEW, session.headers)

			expect(status).toBe(401)
			expect(json.errors?.[0]?.message).toBe('Unauthorized')
			expect(await storedAdminHash(admin._id)).toBe(before)
		} finally {
			await session.cleanup()
		}
	})

	// A disabled operator keeps a working access token until it expires — the Redis session is not
	// revoked by the flag. checkUserAuthorizationDisDel is what stops the write, and it runs before
	// the password is compared, so a suspended account cannot use this endpoint to confirm a guess
	// either. Same 401 as a wrong password: the caller learns nothing about the account.
	it('refuses a disabled operator and leaves the stored hash untouched', async () => {
		const admin = await seedAdmin(OLD, { disabled: true })
		const session = await withSession(admin.email, admin._id)
		const before = await storedAdminHash(admin._id)

		try {
			const { status, json } = await updatePwd(OLD, NEW, session.headers)

			expect(status).toBe(401)
			expect(json.errors?.[0]?.message).toBe('Unauthorized')
			expect(await storedAdminHash(admin._id)).toBe(before)
		} finally {
			await session.cleanup()
		}
	})

	// The default session points at an ObjectId no admin document carries: a session that outlived
	// the account it names. 401 rather than 404 or 500 — the session is what is no good.
	it('refuses a session whose account is not in the collection', async () => {
		const session = await withSession()

		try {
			const { status, json } = await updatePwd(OLD, NEW, session.headers)

			expect(status).toBe(401)
			expect(json.errors?.[0]?.message).toBe('Unauthorized')
		} finally {
			await session.cleanup()
		}
	})

	// checkPwdLen's lower bound, over the wire. It runs before the account is even read, so a caller
	// cannot use a too-short password to find out whether the session still names a real operator.
	it('refuses a new password shorter than the minimum, before reading the account', async () => {
		const admin = await seedAdmin(OLD)
		const session = await withSession(admin.email, admin._id)
		const before = await storedAdminHash(admin._id)

		try {
			const { status, json } = await updatePwd(OLD, 'short', session.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(await storedAdminHash(admin._id)).toBe(before)
		} finally {
			await session.cleanup()
		}
	})
})

describe('non-GraphQL routes', () => {
	it('serves /health once the bearer gate is satisfied', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${base}/health`, { headers: session.headers })

			expect(res.status).toBe(200)
			const json = (await res.json()) as { status: string; timestamp: string }
			expect(json.status).toBe('OK')
		} finally {
			await session.cleanup()
		}
	})

	it('falls through to 404 for an unknown path', async () => {
		const session = await withSession()

		try {
			const res = await fetch(`${base}/nope`, { headers: session.headers })

			expect(res.status).toBe(404)
		} finally {
			await session.cleanup()
		}
	})
})
