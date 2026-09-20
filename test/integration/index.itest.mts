import { randomUUID } from 'node:crypto'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { decryptDocument } from '@axiumine/marketplace-common/encryption/decryptDocument'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import {
	ENCRYPTED_FIELDS_ADMIN,
	ENCRYPTED_FIELDS_COMPANY,
	ENCRYPTED_FIELDS_SHOP_OWNER,
	ENCRYPTED_FIELDS_USER,
	KEY_ALT_NAME_ADMIN,
	KEY_ALT_NAME_COMPANY,
	KEY_ALT_NAME_SHOP_OWNER,
	KEY_ALT_NAME_USER
} from '@axiumine/marketplace-common/encryption/encryptedFields'
import { ALGORITHM_DETERMINISTIC } from '@axiumine/marketplace-common/encryption/EncryptionAlgorithm'
import { encryptValue } from '@axiumine/marketplace-common/encryption/fieldEncryption'
import {
	SCRUBBED_DISABLED_REASON,
	SCRUBBED_FIRST_NAME,
	SCRUBBED_LAST_NAME,
	SCRUBBED_PASSWORD_HASH,
	scrubbedEmail
} from '@axiumine/marketplace-common/others/accountScrub'
import { IReuseEvent, recordReuseEvent } from '@axiumine/marketplace-common/others/recordReuseEvent'
import { retentionLockKey } from '@axiumine/marketplace-common/others/retentionKeys'
import {
	indexSession,
	readSessionHash,
	reuseEventsKey,
	sessionIndexKey,
	sessionKey
} from '@axiumine/marketplace-common/others/sessionKeys'
import { sha256Hex } from '@axiumine/marketplace-common/others/sha256Hex'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { hash, verify } from '@node-rs/bcrypt'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources, handler); this is a
// belt-and-suspenders load so the REDIS_*/MONGODB_URI values are present at this file's top level.
dotenv.config()

import { ENDPOINT } from '../../src/index.mts'
import { retentionCutoff, retentionSweep } from '../../src/lib/retention/retentionSweep.mts'
import { bootServer } from './bootServer.mts'

const REDIS_KEY = process.env.REDIS_KEY as string

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
async function withSession(email = 'admin@marketplace.test', _id = new mongoose.Types.ObjectId()) {
	const token = `access:${randomUUID()}`
	const key = sessionKey(token)

	seededKeys.push(key)
	// `tier` is what a real login writes and what this service asserts on every request: the auth
	// middleware calls assertTier before ctx.state.user is set, so a tier-less seed is refused with
	// 403 and every test built on this helper fails at the guard instead of reaching its resolver.
	await redisClient.hSet(key, { _id: _id.toHexString(), email, tier: TIER.admin })

	// `_id` is handed back because ADR-044 makes it an assertable output: `disabledBy` and `deletedBy` are
	// written from `ctx.state.user._id`, which is this field of this hash and nothing the request can name.
	return {
		_id,
		headers: { authorization: `Bearer ${token}` },
		cleanup: () => redisClient.del(key)
	}
}

/**
 * A live session on the cluster for one account of one tier: the refresh hash a login writes, plus the
 * entry that login files under the account's session index. What `shopOwnerUpdateStatus` and
 * `userUpdateStatus` have to be able to end.
 *
 * ⚠️ **The tier is a parameter because the index key is per tier and nothing else separates two accounts
 * that happen to share an `_id`.** Seeding a customer's session under `TIER.shopOwner` would give the
 * revocation an index it can find, so a `userUpdateStatus` reading the wrong index would pass — the
 * single failure `userUpdateStatus` has to catch.
 *
 * ⚠️ **`indexSession` writes the index rather than a literal `hSet` here, deliberately.** The field name
 * is the digest of the *prefixed* token and nothing about it is guessable from the outside; spelling it
 * by hand in a test would make this suite pass against a revocation that looks in the wrong place, which
 * is the one failure the story exists to catch. Both keys are registered before the first write, so a
 * throw between them still leaves them drainable in `afterAll` (BCON-09).
 *
 * `sessionCapDays: '1'` because nothing here rotates — the field TTL only has to outlive the test.
 */
async function seedSession(tier: (typeof TIER)[keyof typeof TIER], _id: mongoose.Types.ObjectId) {
	const token = `refresh:${randomUUID()}`
	const key = sessionKey(token)
	const index = sessionIndexKey(tier, _id.toHexString())
	const refreshData = {
		_id: _id.toHexString(),
		tier,
		familyId: randomUUID(),
		originalLogin: `${Date.now()}`,
		sessionCapDays: '1'
	}

	const before = new Set(Object.keys(await redisClient.hGetAll(index)))

	seededKeys.push(key, index)
	await redisClient.hSet(key, refreshData)
	await indexSession(redisClient, token, refreshData)

	/*
	 * `token` and `familyId` are handed back for the session console tests, which need to assert that neither
	 * reaches the wire; `field` is the digest the index filed this session under, and therefore the `id`
	 * the console renders and takes back.
	 *
	 * ⚠️ **Read off the index as the difference this write made, never recomputed and never `keys[0]`.**
	 * Hashing the token here would make the suite agree with a `sessions` query that hashed it the same
	 * wrong way, which is the one failure the story exists to catch; taking the first key breaks the
	 * moment an account holds two sessions, silently handing back the other one's id.
	 */
	const added = Object.keys(await redisClient.hGetAll(index)).filter((f) => !before.has(f))

	if (added.length !== 1) throw new Error(`expected indexSession to add exactly one field, it added ${added.length}`)

	return { key, index, token, field: added[0], familyId: refreshData.familyId }
}

/** The two tiers an admin can end a session on from this service. */
const seedShopOwnerSession = (_id: mongoose.Types.ObjectId) => seedSession(TIER.shopOwner, _id)
const seedUserSession = (_id: mongoose.Types.ObjectId) => seedSession(TIER.user, _id)

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
const seededItems: mongoose.Types.ObjectId[] = []
const seededAdmins: mongoose.Types.ObjectId[] = []
const seededUsers: mongoose.Types.ObjectId[] = []
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
 * The suspension a seed carries, on either account collection.
 *
 * ⚠️ **`disabledReason` is not optional beside `disabled: true`.** The validator rule
 * `dependencies: { disabled: ['disabledReason'] }` (ADR-044) makes a reasonless suspension a
 * `Document failed validation` at insert time, so a seed that parks an account has to carry one — and
 * both seeds run `encryptDocument`, which covers the field on both tiers.
 *
 * `disabledBy` is deliberately absent: it is an admin id, and a seed has no admin. The rule asserts
 * the reason only, so a suspension without an actor still inserts — which is also the shape a
 * pre-ADR-044 document has on a real cluster.
 */
const SUSPENDED = { disabled: true, disabledReason: 'itest suspension' }

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
async function seedCompany(idShopOwner: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) {
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
					// false is what `funCompanyAdd` stamps. `publicName` and `slug` stay off on purpose — the
					// collection's `$expr` demands them only of a published document, and `slug` carries a unique index
					// a fixed literal would collide on.
					published: false,
					registryExtract: 'itest-registryExtract',
					...extra
				},
				ENCRYPTED_FIELDS_COMPANY,
				KEY_ALT_NAME_COMPANY
			)
		)
	seededCompanies.push(_id)

	return { _id, legalName }
}

/**
 * A live storefront under one shop owner: a published company with a published item in it. What ADR-045's
 * cascade has to take down when the owner is suspended or closed.
 *
 * ⚠️ **Published is the whole point of the fixture, and it is not the default `seedCompany` writes.** A
 * company that was already `published: false` would satisfy every assertion below without the cascade
 * running at all, so the seed states the live state explicitly — and with it `publicName` and `slug`,
 * which the collection's `$expr` demands of a published document and of no other.
 *
 * `item` is seeded raw and unencrypted: nothing on it is personal data, so it carries no `binData` and no
 * `KEY_ALT_NAME`. `idCategory` names no real `itemCategory` on purpose — the FK is unenforced by the
 * database on this collection, and the cascade filters on `idCompany` alone.
 */
async function seedStorefront(idShopOwner: mongoose.Types.ObjectId) {
	const slug = `itest-shop-${randomUUID()}`
	const company = await seedCompany(idShopOwner, { published: true, publicName: `Itest Storefront ${slug}`, slug })

	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('item')
		.insertOne({
			_id,
			idCompany: company._id,
			idCategory: new mongoose.Types.ObjectId(),
			name: 'Itest Item',
			description: 'Seeded by the cascade tests.',
			slug: `itest-item-${randomUUID()}`,
			published: true
		})
	seededItems.push(_id)

	return { company: company._id, item: _id }
}

/** `published` as the two collections hold it right now, which is the only thing the cascade changes. */
async function storefrontPublished({ company, item }: { company: mongoose.Types.ObjectId; item: mongoose.Types.ObjectId }) {
	return {
		company: (await db().collection('company').findOne({ _id: company }))?.published,
		item: (await db().collection('item').findOne({ _id: item }))?.published
	}
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
					personalData: { firstName: 'Itest', lastName: 'Admin' },
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

/**
 * One customer, inserted with the raw driver like every other seed here.
 *
 * ⚠️ **`personalData` is absent and that is the ordinary state of this collection**, not a shortcut:
 * registration on the customer tier is an address and a password, the name and the addresses arrive
 * later, and `user` is the one collection whose validator makes `personalData` optional for that reason.
 * The table under test projects nothing from it either way — every field in it is ciphertext an admin
 * has no task for (ADR-029).
 *
 * `encryptDocument` still runs, because `login.email` is deterministically encrypted on this collection
 * and a raw seed of plaintext is refused by the validator's `binData` declaration. Deterministic is also
 * what lets the query hand the address back as plaintext, which is what these tests assert on.
 */
async function seedUser(extra: Record<string, unknown> = {}) {
	const email = `itest-user-${randomUUID()}@marketplace.invalid`
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('user')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email, password: PASSWORD_HASH },
					registeredAt: new Date(),
					...extra
				},
				ENCRYPTED_FIELDS_USER,
				KEY_ALT_NAME_USER
			)
		)
	seededUsers.push(_id)

	return { _id, email }
}

beforeAll(async () => {
	const booted = await bootServer()
	httpServer = booted.httpServer
	base = booted.base
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
	for (const _id of seededItems) {
		await drainSafely(`item ${_id.toString()}`, () => db().collection('item').deleteOne({ _id }))
	}
	for (const _id of seededCompanies) {
		await drainSafely(`company ${_id.toString()}`, () => db().collection('company').deleteOne({ _id }))
	}
	for (const _id of seededAdmins) {
		await drainSafely(`admin ${_id.toString()}`, () => db().collection('admin').deleteOne({ _id }))
	}
	for (const _id of seededUsers) {
		await drainSafely(`user ${_id.toString()}`, () => db().collection('user').deleteOne({ _id }))
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

	/*
	 * The customer counterparts of the two tests above, added on 2026-08-29, driven
	 * against the real collection for the same two reasons — and for one more that is specific to `user`.
	 *
	 * ⚠️ `user` is the collection encrypted whole (ADR-029). `registeredAt` is NOT one of the encrypted
	 * paths, and this is the test that proves it: `$dateToString` over a `binData` field does not throw,
	 * it groups every document under one meaningless key, so a field that silently joined
	 * `ENCRYPTED_FIELDS_USER` would collapse the whole series into a single bucket here while every unit
	 * test — which mocks `aggregate` — went on passing. The `$match` bound is the same proof: a range
	 * predicate against random ciphertext matches nothing at all.
	 */
	it('counts and buckets the real customer collection, and keeps the range bound', async () => {
		const session = await withSession()
		const today = new Date().toISOString().slice(0, 10)
		const query = '{ usersStats usersPerPeriod(period: ONE_MONTH) { granularity points { date total } } }'

		try {
			const before = await gql(query, session.headers)

			expect(before.status).toBe(200)
			expect(before.json.errors).toBeUndefined()

			const statsBefore = before.json.data?.usersStats as number
			const seriesBefore = before.json.data?.usersPerPeriod as {
				granularity: string
				points: Array<{ date: string; total: number }>
			}
			expect(typeof statsBefore).toBe('number')
			expect(seriesBefore.granularity).toBe('DAY')
			// Gap-filled, so today is present whether or not anyone registered today.
			expect(seriesBefore.points.at(-1)?.date).toBe(today)

			await seedUser()
			await seedUser({ registeredAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })

			const after = await gql(query, session.headers)
			const statsAfter = after.json.data?.usersStats as number
			const seriesAfter = after.json.data?.usersPerPeriod as { points: Array<{ date: string; total: number }> }

			// The tile counts both seeds; the one-month series sees only the one stamped today. The two
			// numbers disagreeing by exactly the out-of-range document is what makes the bound real.
			expect(statsAfter).toBe(statsBefore + 2)
			expect(seriesAfter.points).toHaveLength(seriesBefore.points.length)
			expect(seriesAfter.points.at(-1)?.total).toBe((seriesBefore.points.at(-1)?.total as number) + 1)

			const sumBefore = seriesBefore.points.reduce((tot, p) => tot + p.total, 0)
			const sumAfter = seriesAfter.points.reduce((tot, p) => tot + p.total, 0)
			expect(sumAfter).toBe(sumBefore + 1)
		} finally {
			await session.cleanup()
		}
	})

	// The projection in shopOwnerById is long and hand-written; running it against a document
	// this run inserted is the only way to see that it really returns the nested login/personalData
	// shape the admin frontend renders.
	//
	// ⚠️ `notes` is asked for here because it is where that went wrong: the projection spelt the field
	// `note`, Mongoose dropped the unknown token without a word, and the admin note came back `null`
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
		const disabledOwner = await seedShopOwner(SUSPENDED)

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

	/****************************************************************************************
	 * usersActiveTbl — the admin's first read of the customer collection.
	 *
	 * ⚠️ The exact-`total` assertions below are only stable because this file is the only one on the
	 * platform that seeds `user`, and globalSetup drops and re-migrates the database before every run
	 * with `SEED_DEMO=false`. Each of them isolates its own rows on a filter no other test here uses.
	 ****************************************************************************************/

	// The mirror of the shopOwner test above, with the extra assertion that matters on this collection:
	// `login.email` comes back as an ADDRESS. It is stored as `binData` under the deterministic
	// algorithm, so plaintext here proves the driver decrypted it on the way out — which is the whole
	// reason the table can identify a row at all without a search argument it cannot have.
	it('lists the live customers, leaves a disabled one out, and hands the address back decrypted', async () => {
		const session = await withSession()
		const active = await seedUser()
		const disabled = await seedUser(SUSPENDED)

		try {
			const { json } = await gql('{ usersActiveTbl { items { _id email } total } }', session.headers)

			expect(json.errors).toBeUndefined()
			const page = json.data?.usersActiveTbl as { items: Array<{ _id: string; email: string }>; total: number }
			const ids = page.items.map((doc) => doc._id)
			expect(ids).toContain(active._id.toHexString())
			expect(ids).not.toContain(disabled._id.toHexString())

			expect(page.items.find((doc) => doc._id === active._id.toHexString())?.email).toBe(active.email)

			// `total` counts the whole filtered set, not the page — it is what the frontend turns into a
			// page count, so it has to be at least as large as the page it came with.
			expect(page.total).toBeGreaterThanOrEqual(ids.length)
			expect(ids.length).toBeLessThanOrEqual(25)
		} finally {
			await session.cleanup()
		}
	})

	// Offset, limit, sort direction and total, driven together against the real collection — and driven
	// over the soft-deleted page on purpose. It is the one page `tbl_active_registeredAt` cannot order
	// (`deleted: {$exists: true}` is a range on the index's leading field, so MongoDB sorts in memory),
	// which makes it the page worth proving comes back in the right order. It is also the only filter
	// nothing else in this file seeds, so `total` is exactly 3 whatever else the run has inserted.
	it('pages and sorts the soft-deleted customers, and keeps them off the default page', async () => {
		const session = await withSession()
		const seeded: Array<{ _id: mongoose.Types.ObjectId; email: string }> = []

		for (const day of ['01', '02', '03']) {
			seeded.push(
				await seedUser({
					registeredAt: new Date(`2026-01-${day}T00:00:00Z`),
					deleted: new Date(`2026-02-${day}T00:00:00Z`)
				})
			)
		}
		const [oldest, middle, newest] = seeded.map((user) => user.email)

		/** Every page below is the same filter, so only what changes per call is a parameter. */
		async function page(extra: string) {
			const { json } = await gql(`{ usersActiveTbl(deleted: true, ${extra}) { items { email } total } }`, session.headers)
			expect(json.errors).toBeUndefined()
			const result = json.data?.usersActiveTbl as { items: Array<{ email: string }>; total: number }

			return { emails: result.items.map((doc) => doc.email), total: result.total }
		}

		try {
			expect(await page('limit: 2, sortDir: ASC, offset: 0')).toEqual({ emails: [oldest, middle], total: 3 })

			// `total` stays 3 while the page moves: the count is of the filter, not of the slice.
			expect(await page('limit: 2, sortDir: ASC, offset: 2')).toEqual({ emails: [newest], total: 3 })

			// One index serves a sort and its complete inverse, which is why both components carry the
			// same direction — asserted here as the reversed page.
			expect(await page('limit: 2, sortDir: DESC, offset: 0')).toEqual({ emails: [newest, middle], total: 3 })

			// Past the end is an empty page, not an error: the frontend can land on a stale page number
			// and has to render an empty table rather than break.
			expect(await page('limit: 2, sortDir: ASC, offset: 100')).toEqual({ emails: [], total: 3 })

			// ⚠️ And the other side of the same filter: the default page is the LIVE accounts. Defaulting
			// the other way is a `defaultValue` on one line, and this is the assertion that would have to
			// change with it.
			const { json } = await gql('{ usersActiveTbl { items { email } } }', session.headers)
			const live = (json.data?.usersActiveTbl as { items: Array<{ email: string }> }).items.map((doc) => doc.email)
			for (const email of [oldest, middle, newest]) expect(live).not.toContain(email)
		} finally {
			await session.cleanup()
		}
	})

	// ⚠️ The unverified customer has **no `emailVerify.valid` key at all** — `enableEmailAccess` in the
	// public-resource service is what writes it — so the filter for "not confirmed" has to be `$ne: true`
	// and not `$eq: false`. Driven against the real collection because that is the only place the
	// difference shows: `{valid: false}` matches nothing here and would answer "nobody is unverified" on
	// precisely the accounts that are.
	it('separates the confirmed customers from the ones with no emailVerify key at all', async () => {
		const session = await withSession()
		const confirmed = await seedUser({ emailVerify: { valid: true } })
		const pending = await seedUser()

		async function emails(emailVerified: boolean) {
			const { json } = await gql(
				`{ usersActiveTbl(emailVerified: ${String(emailVerified)}, limit: 100) { items { email emailVerified } } }`,
				session.headers
			)
			expect(json.errors).toBeUndefined()

			return (json.data?.usersActiveTbl as { items: Array<{ email: string; emailVerified: boolean | null }> }).items
		}

		try {
			const verified = await emails(true)
			expect(verified.map((doc) => doc.email)).toContain(confirmed.email)
			expect(verified.map((doc) => doc.email)).not.toContain(pending.email)
			expect(verified.find((doc) => doc.email === confirmed.email)?.emailVerified).toBe(true)

			const unverified = await emails(false)
			expect(unverified.map((doc) => doc.email)).toContain(pending.email)
			expect(unverified.map((doc) => doc.email)).not.toContain(confirmed.email)
			// Absent on the document, null on the wire — the column renders "not confirmed" on
			// falsiness, never on equality with `false`.
			expect(unverified.find((doc) => doc.email === pending.email)?.emailVerified).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	// Same ceiling, same reason as the shopOwner table: without it a client asks for `limit: 1000000`
	// and pulls the collection through the service — here through the decryption layer as well.
	it('refuses a customers page past the ceiling, before touching the database', async () => {
		const session = await withSession()

		try {
			const { status, json } = await gql('{ usersActiveTbl(limit: 101) { total } }', session.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.data?.usersActiveTbl).toBeUndefined()
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ **The table's boundary over the wire.** Both of these are refused by graphql-js at validation time, before any
	 * resolver runs, which is what makes them unreachable rather than merely unimplemented:
	 *
	 *   - `search` is not an argument, because every field one could match on `user` is ciphertext and a
	 *     prefix match against ciphertext returns nothing WITHOUT erroring — a customer base that renders
	 *     as empty for every term;
	 *   - `LAST_NAME` is not a member of `GraphQLUsersTblSortField`, because a sort on a randomly
	 *     encrypted field is stable, arbitrary and indistinguishable from a working one.
	 *
	 * If either of these ever passes, the two silent failures above are live in the admin app.
	 */
	it.each([
		['a search argument', '{ usersActiveTbl(search: "ros") { total } }', 'search'],
		['a sort on a name', '{ usersActiveTbl(sortBy: LAST_NAME) { total } }', 'LAST_NAME']
	])('rejects %s at schema validation', async (_label, query, expected) => {
		const session = await withSession()

		try {
			const { json } = await gql(query, session.headers)

			expect(json.errors?.[0]?.message).toContain(expected)
			expect(json.data).toBeUndefined()
		} finally {
			await session.cleanup()
		}
	})

	// infoAdminAfterLogin reads nothing but ctx.state.user, so this proves the Redis hash really
	// became the request context — the makeAuthCtx hop, over HTTP.
	it('echoes the session identity back through infoAdminAfterLogin', async () => {
		const email = `admin-${randomUUID()}@marketplace.test`
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
	// It still travels the ordinary way in: every request to this service carries a session or is
	// refused before Apollo sees it.
	it('exposes the assembled schema to an authenticated caller', async () => {
		const session = await withSession()

		try {
			const { status, json } = await gql('{ __schema { queryType { name } mutationType { name } } }', session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data).toEqual({ __schema: { queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } } })
		} finally {
			await session.cleanup()
		}
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
	// funShopOwnerDelete only ever touches `deleted`/`deletedBy`/`waitApprov` — it never assigns
	// `personalData`, so it does not hit the model/validator mismatch below (see shopOwnerAdd and
	// shopOwnerUpdate). It is the one mutation this suite can drive to a genuinely successful
	// write, and re-reading through the raw driver is what proves the $set/$unset really landed on
	// the server rather than only on a mocked query builder.
	//
	// ⚠️ **`deletedBy` is the field that makes the kept document readable a year later** (ADR-044): a
	// closure the platform performed and one the holder performed leave the same `deleted` stamp, and the
	// presence of an actor is the only thing that separates them. It is asserted against the session's own
	// `_id` rather than against "some ObjectId", because the whole point is that it is *that* admin.
	it('soft-deletes a real shopOwner: deleted becomes a real Date, the admin is named, waitApprov is dropped', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner({ waitApprov: true })

		try {
			const { status, json } = await gql(`mutation { shopOwnerDel(_id: "${_id.toHexString()}") }`, session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.shopOwnerDel).toBe(true)

			const updated = await db().collection('shopOwner').findOne({ _id })
			expect(updated?.deleted).toBeInstanceOf(Date)
			expect(updated?.deletedBy).toEqual(session._id)
			expect(updated).not.toHaveProperty('waitApprov')
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ **A second closure must not move the stamp.** The retention window is measured from `deleted`, and
	 * ADR-046 makes those thirty days an undo window the holder can still use — so a re-close of an already
	 * closed account would silently hand it another month of life and push the scrub back. The guard is the
	 * `deleted: { $exists: false }` clause in the filter, which turns the second call into 0 matched.
	 *
	 * The answer is the same 404 an unknown id gets, and deliberately so: from the admin's side both are
	 * "there is no open account with this id", and the API has no reason to tell an admin which of the
	 * two it was.
	 */
	it('refuses to re-close an account already closed, leaving the first stamp where it was', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()

		try {
			expect((await gql(`mutation { shopOwnerDel(_id: "${_id.toHexString()}") }`, session.headers)).json.errors).toBeUndefined()

			const first = (await db().collection('shopOwner').findOne({ _id }))?.deleted

			const { status, json } = await gql(`mutation { shopOwnerDel(_id: "${_id.toHexString()}") }`, session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect((await db().collection('shopOwner').findOne({ _id }))?.deleted).toEqual(first)
		} finally {
			await session.cleanup()
		}
	})

	// The other half of funShopOwnerDelete: the server really reports 0 matched, and that is what turns
	// into the 404 — not a mocked updateOne returning a hand-written result object. This is also the only
	// case that drives shopOwnerDel's own catch arm.
	//
	// ⚠️ **It used to be a 500, and the change is deliberate.** An id naming no open account is something
	// the admin sent — a stale row in a table left open in another tab — and nothing on the server went
	// wrong when it arrived. A 500 tells the admin app to report an outage over a request it could have
	// answered honestly.
	it('answers 404 when the _id matches no shopOwner, and writes nothing', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(`mutation { shopOwnerDel(_id: "${missing.toHexString()}") }`, session.headers)

			// throwNotFoundError carries an http extension, so this one leaves as a real 404 —
			// unlike the validator-driven failures above, which Apollo answers 200-with-errors.
			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.data?.shopOwnerDel).toBeUndefined()

			expect(await db().collection('shopOwner').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ADR-045 on the real cluster, and the half no unit test can prove: the company and the item come down
	 * in the *same transaction* as the stamp, against a real replica set. The mocked session in
	 * `shopOwnerLib.test.mts` asserts that the calls were threaded through one — it cannot assert that the
	 * server accepted the transaction, which is a different claim and the one that has broken before.
	 *
	 * Both documents are asserted live first. A cascade that ran over an already-unpublished storefront and
	 * a cascade that did not run at all leave exactly the same two documents behind.
	 */
	it('takes the whole storefront down with the account: company and item both unpublish', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()
		const storefront = await seedStorefront(_id)

		try {
			expect(await storefrontPublished(storefront)).toEqual({ company: true, item: true })

			const { json } = await gql(`mutation { shopOwnerDel(_id: "${_id.toHexString()}") }`, session.headers)
			expect(json.errors).toBeUndefined()

			expect(await storefrontPublished(storefront)).toEqual({ company: false, item: false })
		} finally {
			await session.cleanup()
		}
	})

	// The cascade is scoped by the FK and by nothing else. Two owners seeded side by side is the cheapest
	// way to catch a filter that lost its `idShopOwner`/`idCompany` clause — an `updateMany({})` would pass
	// every assertion in the test above and take the entire platform offline on the first real closure.
	it('unpublishes only the storefront of the account it closed', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()
		const stranger = await seedShopOwner()
		const mine = await seedStorefront(_id)
		const theirs = await seedStorefront(stranger._id)

		try {
			const { json } = await gql(`mutation { shopOwnerDel(_id: "${_id.toHexString()}") }`, session.headers)
			expect(json.errors).toBeUndefined()

			expect(await storefrontPublished(mine)).toEqual({ company: false, item: false })
			expect(await storefrontPublished(theirs)).toEqual({ company: true, item: true })
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

	/*
	 * Both flags are absent-or-true in the collection, never `false`, so switching one off has to remove
	 * the key. A `$set: { disabled: false }` would validate and read back as "not disabled" too — and
	 * then `waitApprov: { $exists: true }`, which is how the approval queue is built, would list an
	 * account nobody is waiting on.
	 *
	 * ⚠️ **`disabledBy` and `disabledReason` move with `disabled` and are asserted on both edges** — the
	 * three are one fact spelled across three fields (ADR-044), and the release is where they come apart:
	 * a `$unset` that forgot the other two would leave a live account carrying a suspension reason and the
	 * name of whoever imposed it, which then reads as evidence of a suspension that is not in force. The
	 * validator cannot catch that — `dependencies` constrains a document that *has* `disabled`, and this
	 * one no longer does.
	 */
	it('shopOwnerUpdateStatus: stores the trio and both flags, then removes them rather than storing false', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()

		function status(disabled: boolean, waitApprov: boolean) {
			const reason = disabled ? ', disabledReason: "Fake registry extract"' : ''

			return gql(
				`mutation { shopOwnerUpdateStatus(_id: "${_id.toHexString()}", disabled: ${disabled}, waitApprov: ${waitApprov}${reason}) }`,
				session.headers
			)
		}

		try {
			expect((await status(true, true)).json.data?.shopOwnerUpdateStatus).toBe(true)

			const flagsOn = await decrypted(await db().collection('shopOwner').findOne({ _id }))
			expect(flagsOn?.disabled).toBe(true)
			expect(flagsOn?.waitApprov).toBe(true)
			expect(flagsOn?.disabledBy).toEqual(session._id)
			expect(flagsOn?.disabledReason).toBe('Fake registry extract')

			expect((await status(false, false)).json.errors).toBeUndefined()

			const flagsOff = await db().collection('shopOwner').findOne({ _id })
			expect(flagsOff).not.toHaveProperty('disabled')
			expect(flagsOff).not.toHaveProperty('waitApprov')
			expect(flagsOff).not.toHaveProperty('disabledBy')
			expect(flagsOff).not.toHaveProperty('disabledReason')
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * The conditional argument, refused on the real endpoint. `disabledReason` is nullable on the wire
	 * because graphql-js cannot say "required when this other argument is true", so the whole contract is
	 * `validateDisabledReason` and the 400 it raises — and the assertion that matters is the second one:
	 * **nothing was written.** A suspension that reached the collection and then failed validation would be
	 * refused by `dependencies` anyway, as a 500; a suspension that reached it *with* a reason the service
	 * never checked would be a 1000-character cap that does not exist.
	 */
	it('shopOwnerUpdateStatus: refuses a suspension carrying no reason, and parks nobody', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()

		try {
			const { status, json } = await gql(
				`mutation { shopOwnerUpdateStatus(_id: "${_id.toHexString()}", disabled: true, waitApprov: false) }`,
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('disabledReason: field required')

			expect(await db().collection('shopOwner').findOne({ _id })).not.toHaveProperty('disabled')
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ADR-045 through the suspension path, on the real cluster: a parked owner is a shop the public cannot
	 * reach, which takes the company and every item under it down in the same transaction as the flag.
	 *
	 * ⚠️ **Releasing the account restores nothing, and the third assertion is the whole rule.** ADR-045's
	 * amendment is explicit that there is no automatic republish: the platform cannot know which of the
	 * items were drafts before the suspension and which were live, and guessing wrong puts a page back on
	 * the public internet that its owner had taken down. The owner republishes what they want back.
	 */
	it('shopOwnerUpdateStatus: parking unpublishes the storefront, and releasing leaves it down', async () => {
		const session = await withSession()
		const { _id } = await seedShopOwner()
		const storefront = await seedStorefront(_id)

		const status = (extra: string) =>
			gql(`mutation { shopOwnerUpdateStatus(_id: "${_id.toHexString()}", ${extra}) }`, session.headers)

		try {
			expect(await storefrontPublished(storefront)).toEqual({ company: true, item: true })

			expect(
				(await status('disabled: true, waitApprov: false, disabledReason: "Fake registry extract"')).json.errors
			).toBeUndefined()
			expect(await storefrontPublished(storefront)).toEqual({ company: false, item: false })

			expect((await status('disabled: false, waitApprov: false')).json.errors).toBeUndefined()
			expect(await storefrontPublished(storefront)).toEqual({ company: false, item: false })
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * End to end on the real cluster: a shop owner parked by an admin loses the sessions they
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
				`mutation { shopOwnerUpdateStatus(_id: "${_id.toHexString()}", disabled: true, waitApprov: false, disabledReason: "Fake registry extract") }`,
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
		const { _id } = await seedShopOwner({ ...SUSPENDED, waitApprov: true })
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
	// one optional string and is unset when the admin empties the box.
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
 * `userUpdateStatus` — the first write this platform has ever made to a customer account from
 * the admin tier, and the only writer `user.disabled` has.
 *
 * ⚠️ **The refusal these tests would ideally assert happens on three other services** — `tryLoginUser` on
 * 4028, `tokenInfoUser` on 4031, `funUserUpdatePwd` on 4032 — none of which this suite boots. What is
 * shared is MongoDB and Redis, so what is asserted here is the document and the keyspace: the flag is
 * present or absent, and the customer's sessions are gone or untouched. After that the three gates refuse
 * by construction.
 */
describe('userUpdateStatus mutation (real user collection, real session index)', () => {
	/** A suspension carries a reason and a release carries none — `validateDisabledReason` refuses the rest. */
	function updateStatus(_id: mongoose.Types.ObjectId, disabled: boolean, headers: Record<string, string>) {
		const reason = disabled ? ', disabledReason: "Chargeback ring"' : ''

		return gql(`mutation { userUpdateStatus(_id: "${_id.toHexString()}", disabled: ${disabled}${reason}) }`, headers)
	}

	/*
	 * The flag is absent-or-true, never `false`, exactly as it is on `shopOwner` — and here the second
	 * spelling would be visible in the admin's own table within a page load: `usersActiveTbl` selects
	 * the live customers with `{disabled: {$exists: false}}`, so a stored `false` would drop every
	 * re-enabled customer off the default page and list them among the suspended.
	 *
	 * ⚠️ **All three of `disabled`, `disabledBy` and `disabledReason` move together** (ADR-044), and the
	 * release edge is where they can come apart: a `$unset` naming only the flag would leave a live
	 * customer carrying a suspension reason and the name of whoever imposed it. `dependencies` cannot
	 * catch that — it constrains a document that *has* `disabled`, and this one no longer does.
	 */
	it('stores the trio, then removes it rather than storing false', async () => {
		const session = await withSession()
		const { _id } = await seedUser()

		try {
			expect((await updateStatus(_id, true, session.headers)).json.data?.userUpdateStatus).toBe(true)

			const suspended = await decrypted(await db().collection('user').findOne({ _id }))
			expect(suspended?.disabled).toBe(true)
			expect(suspended?.disabledBy).toEqual(session._id)
			expect(suspended?.disabledReason).toBe('Chargeback ring')

			expect((await updateStatus(_id, false, session.headers)).json.errors).toBeUndefined()

			const released = await db().collection('user').findOne({ _id })
			expect(released).not.toHaveProperty('disabled')
			expect(released).not.toHaveProperty('disabledBy')
			expect(released).not.toHaveProperty('disabledReason')
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * The conditional argument on the customer tier, refused on the real endpoint. `disabledReason` is
	 * nullable on the wire because graphql-js cannot say "required when this other argument is true", so
	 * the contract is `validateDisabledReason` and the 400 it raises — and the second assertion is the one
	 * that matters: nothing was written, so a customer is never parked by a request the service refused.
	 */
	it('refuses a suspension carrying no reason, and suspends nobody', async () => {
		const session = await withSession()
		const { _id } = await seedUser()

		try {
			const { status, json } = await gql(
				`mutation { userUpdateStatus(_id: "${_id.toHexString()}", disabled: true) }`,
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('disabledReason: field required')

			expect(await db().collection('user').findOne({ _id })).not.toHaveProperty('disabled')
		} finally {
			await session.cleanup()
		}
	})

	// ⚠️ The write names the `disabled` trio and nothing else. `user` is encrypted whole, so a write that
	// reached any other path would either be refused by the validator's `binData` declaration or — worse —
	// store readable plaintext in a collection whose whole premise is that it holds none. `disabledReason`
	// is the one encrypted field it may name, and the model's plugin turns that `$set` operand into
	// ciphertext on the way past — which is why the assertion above has to go through `decrypted`.
	it('leaves the encrypted document exactly as it found it', async () => {
		const session = await withSession()
		const { _id, email } = await seedUser()
		const before = await db().collection('user').findOne({ _id })

		try {
			await updateStatus(_id, true, session.headers)

			const after = await db().collection('user').findOne({ _id })

			expect(after?.login).toEqual(before?.login)
			expect(after?.registeredAt).toEqual(before?.registeredAt)
			// And it still reads back decrypted through the table, which is what would fail if the update
			// had rewritten `login` as plaintext: the driver decrypts only what it encrypted, and the raw
			// handle these findOne calls use holds no key at all.
			const { json } = await gql('{ usersActiveTbl(disabled: true, limit: 100) { items { _id email } } }', session.headers)
			const rows = (json.data?.usersActiveTbl as { items: Array<{ _id: string; email: string }> }).items

			expect(rows.find((row) => row._id === _id.toHexString())?.email).toBe(email)
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * Suspending an account on the customer tier ends the sessions it was holding at that moment.
	 *
	 * ⚠️ **The session is seeded under `idx:user:` and the revocation has to read that key.** This is the
	 * test that fails on the one mistake `userUpdateStatus` can make — `TIER.shopOwner` copied along with the rest of
	 * `endEveryShopOwnerSession` — because that index does not exist for this `_id`, `hKeys` answers empty,
	 * nothing is deleted, and the mutation still answers `true`.
	 */
	it('suspending a customer deletes the sessions they were holding, index included', async () => {
		const session = await withSession()
		const { _id } = await seedUser()
		const { key, index } = await seedUserSession(_id)

		try {
			// The seed is asserted live first: a revocation that deleted nothing and a seed that wrote
			// nothing leave the same empty keyspace behind, and only this line separates them.
			expect(await redisClient.hGetAll(key)).toMatchObject({ _id: _id.toHexString(), tier: TIER.user })
			expect(Object.keys(await redisClient.hGetAll(index))).toHaveLength(1)

			expect((await updateStatus(_id, true, session.headers)).json.data?.userUpdateStatus).toBe(true)

			expect(await redisClient.hGetAll(key)).toEqual({})
			expect(await redisClient.hGetAll(index)).toEqual({})
		} finally {
			await session.cleanup()
		}
	})

	// The other half of the rule: re-enabling is not a credential event and leaves whoever is signed in
	// signed in. Nothing revokes on the way out of a suspension.
	it('re-enabling a customer leaves their live sessions alone', async () => {
		const session = await withSession()
		const { _id } = await seedUser(SUSPENDED)
		const { key, index } = await seedUserSession(_id)

		try {
			expect((await updateStatus(_id, false, session.headers)).json.errors).toBeUndefined()

			expect(await redisClient.hGetAll(key)).toMatchObject({ _id: _id.toHexString(), tier: TIER.user })
			expect(Object.keys(await redisClient.hGetAll(index))).toHaveLength(1)
		} finally {
			await session.cleanup()
		}
	})

	// ⚠️ The admin's own session survives. This is the cross-account revoke, not `endEverySession`'s "the caller
	// goes too" — and the caller here authenticates against a different collection on a different tier, so
	// a revocation reaching them would mean the tier separation had failed in both directions at once.
	it('leaves the admin signed in', async () => {
		const session = await withSession()
		const { _id } = await seedUser()

		try {
			await updateStatus(_id, true, session.headers)

			const { json } = await gql('{ infoAdminAfterLogin { email } }', session.headers)

			expect(json.errors).toBeUndefined()
			expect(json.data?.infoAdminAfterLogin).toMatchObject({ email: 'admin@marketplace.test' })
		} finally {
			await session.cleanup()
		}
	})

	// An id matching no customer is a 404, and it is a 404 the admin can actually get: a row left open
	// in a second tab of a table somebody else has since acted on.
	it('answers 404 for an id no customer carries', async () => {
		const session = await withSession()

		try {
			const { status, json } = await updateStatus(new mongoose.Types.ObjectId(), true, session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('user not found')
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ **There is no `waitApprov` argument and there never will be** (`phase5/CUSTOMER_ACCOUNT_ADDRESSES.md` §6, closed
	 * 2026-08-25). Nothing on the customer's own tier reads such a flag, so an argument accepted here would
	 * write a field that gates nothing while the admin believes it gates a login. graphql-js refuses it
	 * at validation, before any resolver runs.
	 */
	it('rejects a waitApprov argument at schema validation', async () => {
		const session = await withSession()
		const { _id } = await seedUser()

		try {
			const { json } = await gql(
				`mutation { userUpdateStatus(_id: "${_id.toHexString()}", disabled: true, waitApprov: true) }`,
				session.headers
			)

			expect(json.errors?.[0]?.message).toContain('waitApprov')
			expect(await db().collection('user').findOne({ _id })).not.toHaveProperty('disabled')
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
			// the same run's tier failures. `published` belongs here even though the input no longer carries
			// one: `funCompanyAdd` stamps it `false`, and the collection has it `required` since
			// 20260804010000-alter-company-public.
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
	 * ⚠️ Enforced by MongoDB itself, not by a pre-flight read: two admins saving the same VAT number
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

	// The path prefix is `company.` because the fields arrive inside one input object, and the admin
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
	 * The publish switch, against the real collection — because the rule it has to respect lives there and
	 * nowhere else: the `$expr` beside the `$jsonSchema` refuses `published: true` on a document without a
	 * stored `slug` and `publicName`, and no unit test with a mocked model can observe it.
	 */
	const publish = (id: string, published: boolean, headers: Record<string, string>) =>
		gql(`mutation { companyUpdatePublished(_id: "${id}", published: ${published}) }`, headers)

	// A shop that has not been named cannot be published, and the refusal has to leave the flag alone
	// rather than half-apply. `seedCompany` writes neither `slug` nor `publicName`, so this is the state
	// every company is in the moment `companyAdd` creates it.
	it('companyUpdatePublished: refuses a company with no slug and no publicName, and leaves the flag false', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const company = await seedCompany(owner._id)

		try {
			const { json } = await publish(company._id.toHexString(), true, session.headers)

			expect(json.errors).toBeDefined()
			expect(await db().collection('company').findOne({ _id: company._id })).toMatchObject({ published: false })
		} finally {
			await session.cleanup()
		}
	})

	// Named first, published second — and both directions, because taking a shop off the site is the same
	// mutation with the flag the other way round and the `$expr` has nothing to say about `false`. The two
	// fields go in with the raw driver: what is under test is the publish call, not the save.
	it('companyUpdatePublished: publishes and unpublishes a named company, without touching the rest of the card', async () => {
		const session = await withSession()
		const owner = await seedShopOwner()
		const company = await seedCompany(owner._id)
		const _id = company._id.toHexString()

		try {
			await db()
				.collection('company')
				.updateOne({ _id: company._id }, { $set: { publicName: 'Itest Shop', slug: `itest-${randomUUID()}` } })

			const published = await publish(_id, true, session.headers)
			expect(published.json.errors).toBeUndefined()
			expect(await db().collection('company').findOne({ _id: company._id })).toMatchObject({ published: true })

			const withdrawn = await publish(_id, false, session.headers)
			expect(withdrawn.json.errors).toBeUndefined()

			// The legal card is asserted untouched on the way back out: this mutation writes one field, so a
			// regression that widened it into a save would show up here as a lost `registryExtract`.
			expect(await db().collection('company').findOne({ _id: company._id })).toMatchObject({
				published: false,
				legalName: company.legalName,
				registryExtract: 'itest-registryExtract'
			})
		} finally {
			await session.cleanup()
		}
	})

	it('companyUpdatePublished: answers 404 when the _id matches no company', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await publish(missing.toHexString(), false, session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('company not found')
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

	// The company is gone from every read path the admin has, which is the whole of what "deleted"
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
	// box the admin cannot fill. `taxCode` and `uniqueCode` come back null — the seed stores neither, which is
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
	// without this a stolen token is permanent ownership of the admin account.
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

	// A disabled admin keeps a working access token until it expires — the Redis session is not
	// revoked by the flag. checkUserAuthorizationDisDel is what stops the write, and it runs before
	// the password is compared, so a suspended account cannot use this endpoint to confirm a guess
	// either. Same 401 as a wrong password: the caller learns nothing about the account.
	it('refuses a disabled admin and leaves the stored hash untouched', async () => {
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
	// cannot use a too-short password to find out whether the session still names a real admin.
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

/*
 * The session console on the real cluster: it lists what a login actually wrote, ends what an admin
 * picks, and reads back the trail the authorization services actually append.
 *
 * ⚠️ **What is asserted after a revocation is the keyspace, not a refused request — the same deviation
 * the shop-owner suspension records above, for the same reason.** The refusal belongs to the service that owns the tier
 * being revoked (`marketplace-dev-authenticated-resource` on 4026 for a `shopOwner`), which this suite
 * neither boots nor can boot. Redis is what the two share, so the honest end-to-end claim available here
 * is that the session hash and its index entry are gone — after which the refresh that service performs
 * has nothing to read and fails by construction. `readSessionHash` is called directly below to make that
 * last step explicit rather than implied: it is the exact read the victim service runs, and it answers
 * the empty hash that every caller turns into a re-login.
 *
 * ⚠️ **The residual is unchanged and is not a defect**: revocation ends the refresh lineage, and an
 * access token already minted from it keeps working until its own short expiry. `indexSession` states
 * this; the console has to say it too, which is the confirmation dialog's job.
 */
describe('session console (real sessions, real index, real reuse trail)', () => {
	/**
	 * The admin whose id meters the rate limit, plus the two meter keys their writes create.
	 *
	 * ⚠️ Registered before the first call that could create them (BCON-09): `assertUnderRateLimit` INCRs
	 * a key named after the admin, so a console test that threw between the write and the drain used
	 * to leave a live counter in the namespace — invisible, and enough to answer 429 to a later run.
	 */
	async function withAdmin() {
		const _id = new mongoose.Types.ObjectId()

		seededKeys.push(
			`${REDIS_KEY}rl:session:revoke:${sha256Hex(_id.toHexString())}`,
			`${REDIS_KEY}rl:session:revokeAll:${sha256Hex(_id.toHexString())}`
		)

		return withSession('admin@marketplace.test', _id)
	}

	it('sessions: lists a real login, keyed by the digest the index filed it under', async () => {
		const session = await withAdmin()
		const _id = new mongoose.Types.ObjectId()
		const { field, token, familyId } = await seedShopOwnerSession(_id)

		try {
			const { json } = await gql(
				`{ sessions(tier: shopOwner, accountId: "${_id.toHexString()}") { id tier mintedAt familyId } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect(json.data?.sessions).toEqual([
				{ id: field, tier: 'shopOwner', mintedAt: expect.stringMatching(/^\d+$/) as unknown as string, familyId }
			])

			// The no-leak check over HTTP, on a response built from a session that really exists: the token that
			// minted it is nowhere in the bytes, prefix or no prefix.
			const body = JSON.stringify(json)
			expect(body).not.toContain(token)
			expect(body).not.toContain(token.replace('refresh:', ''))
		} finally {
			await session.cleanup()
		}
	})

	it('sessions: answers an empty list for an account that has never logged in', async () => {
		const session = await withAdmin()

		try {
			const { json } = await gql(
				`{ sessions(tier: shopOwner, accountId: "${new mongoose.Types.ObjectId().toHexString()}") { id } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect(json.data?.sessions).toEqual([])
		} finally {
			await session.cleanup()
		}
	})

	it('revokeSession: ends the one session named and leaves the account able to hold others', async () => {
		const session = await withAdmin()
		const _id = new mongoose.Types.ObjectId()
		const first = await seedShopOwnerSession(_id)
		const second = await seedShopOwnerSession(_id)

		try {
			// The seeds are asserted live first: a revocation that deleted nothing and a seed that wrote
			// nothing leave the same empty keyspace behind, and only this line separates them.
			expect(Object.keys(await redisClient.hGetAll(first.index))).toHaveLength(2)

			const { json } = await gql(
				`mutation { revokeSession(tier: shopOwner, accountId: "${_id.toHexString()}", id: "${first.field}") }`,
				session.headers
			)
			expect(json.data?.revokeSession).toBe(true)

			// Gone: the hash, and the row that listed it.
			expect(await redisClient.hGetAll(first.key)).toEqual({})
			expect(Object.keys(await redisClient.hGetAll(first.index))).toEqual([second.field])

			// The read the victim service performs on the next refresh, run here verbatim. An empty hash
			// is what every caller of it turns into a re-login.
			expect(await readSessionHash(redisClient, first.token)).toEqual({})

			// And the account's other login is untouched — a revocation is one session, not one account.
			expect(await redisClient.hGetAll(second.key)).toMatchObject({ _id: _id.toHexString(), tier: TIER.shopOwner })
		} finally {
			await session.cleanup()
		}
	})

	// `false` is the already-ended answer, and it has to survive the round trip: the console shows
	// "already ended" on it, and an admin told "error" would retry a call that has nothing left to do.
	it('revokeSession: answers false and still prunes when the session had already gone', async () => {
		const session = await withAdmin()
		const _id = new mongoose.Types.ObjectId()
		const { key, index, field } = await seedShopOwnerSession(_id)

		try {
			await redisClient.del(key)

			const { json } = await gql(
				`mutation { revokeSession(tier: shopOwner, accountId: "${_id.toHexString()}", id: "${field}") }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect(json.data?.revokeSession).toBe(false)
			expect(await redisClient.hGetAll(index)).toEqual({})
		} finally {
			await session.cleanup()
		}
	})

	it('revokeAllSessions: ends every session the account holds and removes the index key itself', async () => {
		const session = await withAdmin()
		const _id = new mongoose.Types.ObjectId()
		const first = await seedShopOwnerSession(_id)
		const second = await seedShopOwnerSession(_id)

		try {
			const { json } = await gql(
				`mutation { revokeAllSessions(tier: shopOwner, accountId: "${_id.toHexString()}") }`,
				session.headers
			)

			expect(json.data?.revokeAllSessions).toBe(2)

			expect(await redisClient.hGetAll(first.key)).toEqual({})
			expect(await redisClient.hGetAll(second.key)).toEqual({})
			expect(await redisClient.hGetAll(first.index)).toEqual({})
			expect(await readSessionHash(redisClient, second.token)).toEqual({})
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * The console does not write this list — the three authorization services do, on a replay. Writing it
	 * here with the *shipped* writer rather than an `lPush` spelled by hand is what makes this an
	 * end-to-end assertion: if `recordReuseEvent` and `funReuseEvents` ever disagreed about the key name,
	 * the field names or the order, this is the test that notices.
	 */
	it('reuseEvents: reads back exactly what the authorization services append, newest first', async () => {
		const session = await withAdmin()
		const _id = new mongoose.Types.ObjectId()
		const accountId = _id.toHexString()
		const older: IReuseEvent = {
			familyId: randomUUID(),
			tier: TIER.shopOwner,
			accountId,
			action: 'refreshTokenReplayed',
			at: '1754784000000'
		}
		const newer: IReuseEvent = { ...older, familyId: randomUUID(), at: '1754784060000' }

		seededKeys.push(reuseEventsKey(TIER.shopOwner, accountId))

		try {
			await recordReuseEvent({ store: redisClient, event: older })
			await recordReuseEvent({ store: redisClient, event: newer })

			const { json } = await gql(
				`{ reuseEvents(tier: shopOwner, accountId: "${accountId}") { familyId tier accountId action at } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			// Newest first, because `lPush` prepends and the console shows the most recent replay at the top.
			expect(json.data?.reuseEvents).toEqual([newer, older])
		} finally {
			await session.cleanup()
		}
	})

	it('reuseEvents: answers an empty trail for an account that has never had a replay', async () => {
		const session = await withAdmin()

		try {
			const { json } = await gql(
				`{ reuseEvents(tier: shopOwner, accountId: "${new mongoose.Types.ObjectId().toHexString()}") { at } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect(json.data?.reuseEvents).toEqual([])
		} finally {
			await session.cleanup()
		}
	})
})

/****************************************************************************************
 * The retention scrub, against real collections (ADR-041).
 *
 * ⚠️ **This block is required by the ADR, and a unit test cannot replace it.** `sanitizeFilter` is
 * on process-wide: an unwrapped `$`-keyed filter value is rewritten to `{ $eq: { $lte: … } }`, which
 * matches nothing for ever while the sweep reports success on every run. A test that asserted the
 * filter object would agree with that mutant; only a real `find` against a real collection can tell
 * a working sweep from a permanent no-op.
 *
 * It also proves the half nothing else can: that the update `buildAccountScrub` produces is one the
 * collection validators accept, through the encryption plugin, on both collections and on a suspended
 * document — the case `dependencies: { disabled: ['disabledReason'] }` would refuse.
 *
 * ⚠️ **Deliberately last in this file.** It is the one thing here that writes documents it did not
 * seed: every closed account in the throwaway database older than the window is a candidate, including
 * ones earlier blocks left behind. That is why the expected counts are read off the collections with
 * the raw driver — which does not pass through `sanitizeFilter` — rather than written as literals.
 ****************************************************************************************/
describe('retention sweep (real scrub, real collections, real validators)', () => {
	const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)

	/** The same two clauses the sweeper uses, spelled for the raw driver so nothing sanitises them. */
	const candidateFilter = (cutoff: Date) => ({ deleted: { $lte: cutoff }, scrubbedAt: { $exists: false } })

	it('overwrites a closed account past its window, spares one still inside it, and never scrubs the same document twice', async () => {
		// The boot in `beforeAll` armed the real sweeper, which took the fleet lock with a one-hour TTL and
		// releases it by design never. Registered for the afterAll drain like every other key this file
		// writes, or it sits in the shared itest namespace for the hour and no later run can read it back.
		seededKeys.push(retentionLockKey())

		const admin = new mongoose.Types.ObjectId()
		const closedAt = daysAgo(31)
		// Suspended as well as closed: the one combination the validator can refuse, because the reason
		// may not be removed while `disabled` stays true. `notes` is the admin's own file on this
		// person and has to go with it.
		const stale = await seedShopOwner({
			deleted: closedAt,
			deletedBy: admin,
			disabled: true,
			disabledBy: admin,
			disabledReason: 'Repeated breaches of the marketplace terms, reported by three customers',
			notes: 'Rang them about the same complaint in August'
		})
		const fresh = await seedShopOwner({ deleted: daysAgo(1) })
		const staleUser = await seedUser({
			deleted: closedAt,
			personalData: { firstName: 'Itest', lastName: 'Customer' }
		})

		const now = new Date()
		const cutoff = retentionCutoff(now)
		const expected = {
			shopOwner: await db().collection('shopOwner').countDocuments(candidateFilter(cutoff)),
			user: await db().collection('user').countDocuments(candidateFilter(cutoff))
		}

		// The counts agreeing is the no-op detector: with either `trusted()` gone, the sweep answers
		// `{ shopOwner: 0, user: 0 }` here while the raw driver still sees the candidates.
		expect(await retentionSweep(now)).toStrictEqual(expected)
		expect(expected.shopOwner).toBeGreaterThanOrEqual(1)
		expect(expected.user).toBeGreaterThanOrEqual(1)

		const scrubbed = await decrypted(await db().collection('shopOwner').findOne({ _id: stale._id }))

		// What the person was, overwritten — read back decrypted, because these paths are `binData` on
		// disk and the plugin had to encrypt the placeholders on the way in for the validator to accept
		// them at all.
		expect(scrubbed?.login.email).toBe(scrubbedEmail(stale._id.toHexString()))
		expect(scrubbed?.login.password).toBe(SCRUBBED_PASSWORD_HASH)
		expect(scrubbed?.personalData.firstName).toBe(SCRUBBED_FIRST_NAME)
		expect(scrubbed?.personalData.lastName).toBe(SCRUBBED_LAST_NAME)
		expect(scrubbed?.personalData.contacts.email).toBe(scrubbedEmail(stale._id.toHexString()))
		expect(scrubbed?.personalData.birth.date).toStrictEqual(new Date(0))
		expect(scrubbed).not.toHaveProperty('notes')

		// ⚠️ Overwritten, not removed: `$unset`ting it here is what the validator refuses, and a sweep
		// that tried would stall on exactly the accounts most likely to reach it.
		expect(scrubbed?.disabledReason).toBe(SCRUBBED_DISABLED_REASON)

		// ⚠️ The record that a person held an account survives the scrub, for ever. `deletedBy` is
		// meaningful by its absence — that is how a self-closure reads — so the sweep may not touch it.
		expect(scrubbed?.disabled).toBe(true)
		expect(scrubbed?.disabledBy).toEqual(admin)
		expect(scrubbed?.deleted).toEqual(closedAt)
		expect(scrubbed?.deletedBy).toEqual(admin)
		expect(scrubbed?.registeredAt).toBeInstanceOf(Date)
		expect(scrubbed?.scrubbedAt).toBeInstanceOf(Date)

		// The other collection, whose scrub is a different shape and a different validator.
		const scrubbedUser = await decrypted(await db().collection('user').findOne({ _id: staleUser._id }))

		expect(scrubbedUser?.login.email).toBe(scrubbedEmail(staleUser._id.toHexString()))
		expect(scrubbedUser?.personalData).toEqual({ firstName: SCRUBBED_FIRST_NAME, lastName: SCRUBBED_LAST_NAME })
		expect(scrubbedUser?.scrubbedAt).toBeInstanceOf(Date)

		// ⚠️ Inside the window and therefore untouched — the account is still undoable by re-registering
		// at this address (ADR-046), so its address must still be spoken for by the real value. This is
		// what makes the cutoff a `$lte` on `deleted` rather than "closed at all".
		const spared = await decrypted(await db().collection('shopOwner').findOne({ _id: fresh._id }))

		expect(spared?.login.email).toBe(fresh.email)
		expect(spared).not.toHaveProperty('scrubbedAt')

		// ⚠️ Idempotence, which is the `scrubbedAt: { $exists: false }` clause doing its job. Without it
		// every sweep would re-scrub every closed account for ever — cheap, but it would also move the
		// stamp, and the stamp is the only record of when erasure actually happened.
		expect(await retentionSweep(new Date())).toStrictEqual({ shopOwner: 0, user: 0 })
		expect((await db().collection('shopOwner').findOne({ _id: stale._id }))?.scrubbedAt).toEqual(scrubbed?.scrubbedAt)
	})
})
