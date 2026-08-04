import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
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
	const key = `${REDIS_KEY}${token}`

	seededKeys.push(key)
	await redisClient.hSet(key, { _id: _id.toHexString(), email })

	return {
		headers: { authorization: `Bearer ${token}` },
		cleanup: () => redisClient.del(key)
	}
}

/****************************************************************************************
 * Seeds. The end-to-end reads need MongoDB to actually hold an imprenditore, so they write
 * one to the dev database and delete it again in afterAll. Every document carries an
 * `itest-…@marketplace.invalid` address, and `login.email` is the collection's unique index.
 ****************************************************************************************/

// Nothing on this tier ever verifies a password, so a seeded hash only has to satisfy the
// validator's exactly-60-characters rule.
const PASSWORD_HASH = `$2y$14$${'x'.repeat(53)}`

const seededIds: mongoose.Types.ObjectId[] = []
const seededAziende: mongoose.Types.ObjectId[] = []
const seededPuntiVendita: mongoose.Types.ObjectId[] = []
const seededAdmins: mongoose.Types.ObjectId[] = []
const seededKeys: string[] = []

/** The raw driver handle — only defined once start() has connected. */
function db() {
	return mongoose.connection.db!
}

/**
 * Inserted with the raw driver rather than the Mongoose model, the platform seeding convention:
 * the insert is then shaped by the collection's own `$jsonSchema` and by nothing else, so a seed
 * cannot inherit whatever the model happens to believe today. That is not hypothetical — the model
 * used to spell `anagrafica.nascita.data` as `date` and carry no `contatti` path at all, both of
 * which the validator refuses under `additionalProperties: false`, so a model write failed outright
 * (fixed in marketplace-common 1.17.0). The raw path was never affected, and will not be by the next
 * drift either.
 */
async function seedImprenditore(extra: Record<string, unknown> = {}) {
	const email = `itest-${randomUUID()}@marketplace.invalid`
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('imprenditore')
		.insertOne({
			_id,
			login: { email, password: PASSWORD_HASH },
			anagrafica: {
				nome: 'Itest',
				cognome: 'Imprenditore',
				nascita: { data: new Date('1980-01-01T00:00:00Z') },
				indirizzo: { indirizzo: 'Via Test 1', cap: '24031', comune: 'Almenno San Salvatore', provincia: 'BG' },
				contatti: { cellulare: '3900000000', email }
			},
			iscrizione: new Date(),
			...extra
		})
	seededIds.push(_id)

	return { _id, email }
}

/** The seat every seed stores, and the payload shape the address validator answers with. */
const INDIRIZZO_SEED = {
	indirizzo: 'Via Test 1',
	cap: '24031',
	comune: 'Almenno San Salvatore',
	provincia: 'BG',
	// GeoJSON order: [longitude, latitude]. Plain JS numbers, not Decimal128 — since
	// 20260801000000-alter-puntoVendita-position the `puntoVendita` validator wants
	// ['double', 'int', 'long'] and rejects decimal, 20260803000000-create-azienda restates the same
	// rule for the company seat, and `puntoVendita` carries a 2dsphere index that fails the write
	// outright if the two axes are swapped.
	position: { type: 'Point', coordinates: [9.57, 45.75] }
}

/**
 * One company, owned by the imprenditore whose `_id` is passed in.
 *
 * Inserted with the raw driver, same reasoning as seedImprenditore. `piva` and `pec` both carry unique
 * indexes — since 20260803000100 they are the only unique indexes left anywhere in this chain, having
 * been dropped from `puntoVendita.azienda.*` and rebuilt here — and `indirizzo.position.coordinates` is
 * validated per axis.
 *
 * The partita IVA comes from the shared counter rather than from the id, so the seeded value is one the
 * validator would also accept back: `FORMA_PIVA` is `/^\d{11}$/` and a hex slice is not eleven digits.
 */
async function seedAzienda(idImprenditore: mongoose.Types.ObjectId) {
	const _id = new mongoose.Types.ObjectId()
	const ragionesociale = `Itest Pizzeria ${randomUUID()}`

	await db()
		.collection('azienda')
		.insertOne({
			_id,
			idImprenditore,
			ragionesociale,
			piva: pivaItest(),
			referente: 'Itest Referente',
			amministratore: 'Itest Amministratore',
			pec: `itest-${_id.toHexString()}@pec.invalid`,
			indirizzo: INDIRIZZO_SEED,
			visura: 'itest-visura'
		})
	seededAziende.push(_id)

	return { _id, ragionesociale }
}

/**
 * One shop, under an imprenditore and pointing at one of that imprenditore's companies.
 *
 * Both ids are required arguments and neither has a default: since 20260803000100 the company is an
 * ObjectId stored under `idAzienda`, both `funPuntoVenditaAdd` and `funPuntoVenditaUpdate` check the
 * pair belongs together, and a seed that minted its own company id would be seeding exactly the state
 * those checks exist to refuse.
 *
 * ⚠️ The field name is load-bearing here in a way a unit test cannot reach: the collection validator
 * carries `additionalProperties: false` and requires `idAzienda`, so a seed still writing `azienda`
 * is rejected by MongoDB itself rather than quietly producing a shop nothing can resolve.
 */
async function seedPuntoVendita(idImprenditore: mongoose.Types.ObjectId, idAzienda: mongoose.Types.ObjectId) {
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('puntoVendita')
		.insertOne({
			_id,
			idImprenditore,
			// The insegna, required since 20260802000200 and deliberately not the ragione sociale of the
			// company: that one names the legal entity that owns the shop, this one names the shop.
			nome: `Itest Insegna ${randomUUID()}`,
			idAzienda,
			indirizzo: INDIRIZZO_SEED,
			contatti: { cellulare: '3900000000' },
			inserted: new Date(),
			orari: [],
			disabled: false
		})
	seededPuntiVendita.push(_id)

	return { _id }
}

/** An imprenditore, one of its companies and one shop under both — the whole chain, in one call. */
async function seedCatena() {
	const owner = await seedImprenditore()
	const azienda = await seedAzienda(owner._id)
	const puntoVendita = await seedPuntoVendita(owner._id, azienda._id)

	return { owner, azienda, puntoVendita }
}

/**
 * An 11-digit partita IVA, distinct on every call.
 *
 * A literal would collide with itself on the second write of a run, and `piva_unique` is global rather
 * than per imprenditore — so the counter is what lets the same payload be sent twice without the second
 * send failing for a reason the test did not intend.
 */
let pivaProgressiva = 0
function pivaItest() {
	return String(90000000000 + ++pivaProgressiva)
}

/**
 * The only seed on this tier that stores a password anyone will ever verify: adminUpdatePwd
 * re-authenticates the caller before it writes. So this one carries a real bcrypt hash of a known
 * plaintext, not the 60 filler characters the imprenditore seeds get away with.
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
		.insertOne({
			_id,
			login: { email, password: await hash(password, 4) },
			anagrafica: { nome: 'Itest', cognome: 'Operator' },
			...extra
		})
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
		await drainSafely(`imprenditore ${_id.toString()}`, () => db().collection('imprenditore').deleteOne({ _id }))
	}
	for (const _id of seededPuntiVendita) {
		await drainSafely(`puntoVendita ${_id.toString()}`, () => db().collection('puntoVendita').deleteOne({ _id }))
	}
	// After the shops, so a run that dies mid-drain leaves the dangling reference rather than the
	// orphaned company: the second is what `piva_unique` would then reject the next seed for.
	for (const _id of seededAziende) {
		await drainSafely(`azienda ${_id.toString()}`, () => db().collection('azienda').deleteOne({ _id }))
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
		const { status, json } = await gql('{ imprenditoriStats }')

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})

	it('answers 499 when the header does not use the `Bearer access:` scheme', async () => {
		const { status, json } = await gql('{ imprenditoriStats }', { authorization: `Bearer ${randomUUID()}` })

		expect(status).toBe(499)
		expect(json.message).toBe('Token Required')
	})

	it('answers 498 when the session is not on the cluster', async () => {
		const { status, json } = await gql('{ imprenditoriStats }', { authorization: `Bearer access:${randomUUID()}` })

		expect(status).toBe(498)
		expect(json.message).toBe('Invalid Token')
	})
})

describe('GraphQL over HTTP', () => {
	// The one request that drives both datasources end to end: Redis authenticates it, MongoDB
	// answers it. No unit test can cover that seam. Counting twice around a seed pins the answer
	// to the real collection — a stubbed or cached count cannot move by exactly one.
	it('counts the imprenditori in the real database for an authenticated admin', async () => {
		const session = await withSession()

		try {
			const before = await gql('{ imprenditoriStats }', session.headers)

			expect(before.status).toBe(200)
			expect(before.json.errors).toBeUndefined()
			expect(typeof before.json.data?.imprenditoriStats).toBe('number')

			await seedImprenditore()

			const after = await gql('{ imprenditoriStats }', session.headers)
			expect(after.json.data?.imprenditoriStats).toBe((before.json.data?.imprenditoriStats as number) + 1)
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
	 * inserting imprenditori and the demo seed may have left its own. Today's bucket must gain exactly
	 * one — the row stamped now — while the row stamped two months back must land outside the one-month
	 * range entirely, which is what proves the `$match` bound is real and not decoration.
	 */
	it('buckets the real collection by day and honours the range bound', async () => {
		const session = await withSession()
		const oggi = new Date().toISOString().slice(0, 10)
		const query = '{ imprenditoriPerPeriodo(periodo: UN_MESE) { granularita punti { data totale } } }'

		try {
			const before = await gql(query, session.headers)

			expect(before.status).toBe(200)
			expect(before.json.errors).toBeUndefined()

			const serieBefore = before.json.data?.imprenditoriPerPeriodo as {
				granularita: string
				punti: Array<{ data: string; totale: number }>
			}
			expect(serieBefore.granularita).toBe('GIORNO')
			// Gap-filled, so today is present whether or not anyone registered today.
			expect(serieBefore.punti.at(-1)?.data).toBe(oggi)

			await seedImprenditore()
			await seedImprenditore({ iscrizione: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })

			const after = await gql(query, session.headers)
			const serieAfter = after.json.data?.imprenditoriPerPeriodo as { punti: Array<{ data: string; totale: number }> }

			expect(serieAfter.punti).toHaveLength(serieBefore.punti.length)
			expect(serieAfter.punti.at(-1)?.totale).toBe((serieBefore.punti.at(-1)?.totale as number) + 1)

			// The two-month-old seed is outside the range, so nothing else in the series moved.
			const sommaBefore = serieBefore.punti.reduce((tot, p) => tot + p.totale, 0)
			const sommaAfter = serieAfter.punti.reduce((tot, p) => tot + p.totale, 0)
			expect(sommaAfter).toBe(sommaBefore + 1)
		} finally {
			await session.cleanup()
		}
	})

	// The projection in imprenditoreById is long and hand-written; running it against a document
	// this run inserted is the only way to see that it really returns the nested login/anagrafica
	// shape the operator frontend renders.
	it('reads a seeded imprenditore back by id, with the projected nested fields', async () => {
		const session = await withSession()
		const { _id, email } = await seedImprenditore()

		try {
			const { status, json } = await gql(
				`{ imprenditoreById(idImprenditore: "${_id.toHexString()}") {
					_id login { email onboardingDone } anagrafica { nome cognome contatti { email cellulare } } waitApprov
				} }`,
				session.headers
			)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditoreById).toEqual({
				_id: _id.toHexString(),
				login: { email, onboardingDone: null },
				anagrafica: { nome: 'Itest', cognome: 'Imprenditore', contatti: { email, cellulare: '3900000000' } },
				waitApprov: null
			})
		} finally {
			await session.cleanup()
		}
	})

	// imprenditoriAttiviTbl filters on `disabled`/`deleted` being absent. Seeding one of each and
	// checking both sides is what proves the filter, rather than a query that happens to return rows.
	//
	// Asked for with no arguments on purpose: the query is now paged, and every argument carries a
	// server-side default. A client that sends nothing must still get a bounded first page — that is
	// what made removing the old unbounded list safe. Both seeds are stamped `iscrizione: new Date()`,
	// so under the default ISCRIZIONE/DESC ordering they are the newest rows and land on page one.
	it('lists the active imprenditori and leaves a disabled one out', async () => {
		const session = await withSession()
		const attivo = await seedImprenditore()
		const disabilitato = await seedImprenditore({ disabled: true })

		try {
			const { json } = await gql('{ imprenditoriAttiviTbl { items { _id } total } }', session.headers)

			expect(json.errors).toBeUndefined()
			const page = json.data?.imprenditoriAttiviTbl as { items: Array<{ _id: string }>; total: number }
			const ids = page.items.map((row) => row._id)
			expect(ids).toContain(attivo._id.toHexString())
			expect(ids).not.toContain(disabilitato._id.toHexString())

			// `total` counts the whole filtered set, not the page — it is what the frontend turns into
			// a page count, so it has to be at least as large as the page it came with.
			expect(page.total).toBeGreaterThanOrEqual(ids.length)
			expect(ids.length).toBeLessThanOrEqual(25)
		} finally {
			await session.cleanup()
		}
	})

	// Search, offset, limit, sort and total, driven together against the real collection. They are
	// one test because they need one shared seed: three rows nothing else in the database can match,
	// which is the only way an assertion about a specific page is stable in a suite that keeps
	// inserting imprenditori. The token is a random prefix no demo row and no other test can start
	// with, so `total` is exactly 3 whatever else the collection holds.
	it('pages, searches and sorts the real collection', async () => {
		const session = await withSession()
		const token = `Zzitest${randomUUID().replace(/-/g, '')}`

		for (const cognome of ['Alfa', 'Beta', 'Gamma']) {
			await seedImprenditore({
				anagrafica: {
					nome: token,
					cognome,
					nascita: { data: new Date('1980-01-01T00:00:00Z') },
					indirizzo: { indirizzo: 'Via Test 1', cap: '24031', comune: 'Almenno San Salvatore', provincia: 'BG' },
					contatti: { cellulare: '3900000000', email: `itest-${randomUUID()}@marketplace.invalid` }
				}
			})
		}

		/** Every page below is the same search, so only what changes per call is a parameter. */
		async function page(extra: string) {
			const { json } = await gql(
				`{ imprenditoriAttiviTbl(search: "${token}", sortBy: COGNOME, ${extra}) {
					items { anagrafica { cognome } } total
				} }`,
				session.headers
			)
			expect(json.errors).toBeUndefined()
			const result = json.data?.imprenditoriAttiviTbl as {
				items: Array<{ anagrafica: { cognome: string } }>
				total: number
			}

			return { cognomi: result.items.map((row) => row.anagrafica.cognome), total: result.total }
		}

		try {
			// The prefix search really narrows the collection to the three seeds — `total` is the size
			// of the FILTERED set, so anything else here means the search term was ignored.
			const first = await page('limit: 2, sortDir: ASC, offset: 0')
			expect(first).toEqual({ cognomi: ['Alfa', 'Beta'], total: 3 })

			// `total` stays 3 while the page moves: the count is of the filter, not of the slice.
			const second = await page('limit: 2, sortDir: ASC, offset: 2')
			expect(second).toEqual({ cognomi: ['Gamma'], total: 3 })

			// The same index serves the reversed order — asserted here as the reversed rows.
			const descending = await page('limit: 2, sortDir: DESC, offset: 0')
			expect(descending).toEqual({ cognomi: ['Gamma', 'Beta'], total: 3 })

			// Past the end is an empty page, not an error: the frontend can land on a stale page
			// number after a row is deleted, and it has to render an empty table rather than break.
			const past = await page('limit: 2, sortDir: ASC, offset: 100')
			expect(past).toEqual({ cognomi: [], total: 3 })
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
			const { status, json } = await gql('{ imprenditoriAttiviTbl(limit: 101) { total } }', session.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.data?.imprenditoriAttiviTbl).toBeUndefined()
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
			const { json } = await gql('{ imprenditoriAttiviTbl(sortBy: PASSWORD) { total } }', session.headers)

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

describe('imprenditoreDel mutation (real write, re-read by the raw driver)', () => {
	// funImprenditoreDelete only ever touches `deleted`/`waitApprov` — it never assigns
	// `anagrafica`, so it does not hit the model/validator mismatch below (see imprenditoreAdd and
	// imprenditoreUpdate). It is the one mutation this suite can drive to a genuinely successful
	// write, and re-reading through the raw driver is what proves the $set/$unset really landed on
	// the server rather than only on a mocked query builder.
	it('soft-deletes a real imprenditore: deleted becomes a real Date, waitApprov is dropped', async () => {
		const session = await withSession()
		const { _id } = await seedImprenditore({ waitApprov: true })

		try {
			const { status, json } = await gql(`mutation { imprenditoreDel(_id: "${_id.toHexString()}") }`, session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditoreDel).toBe(true)

			const updated = await db().collection('imprenditore').findOne({ _id })
			expect(updated?.deleted).toBeInstanceOf(Date)
			expect(updated).not.toHaveProperty('waitApprov')
		} finally {
			await session.cleanup()
		}
	})

	// The other half of funImprenditoreDelete: the server really reports modifiedCount 0, and that
	// is what turns into the 500 — not a mocked updateOne returning a hand-written result object.
	// This is also the only case that drives imprenditoreDel's own catch arm.
	it('answers 500 when the _id matches no imprenditore, and writes nothing', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(`mutation { imprenditoreDel(_id: "${missing.toHexString()}") }`, session.headers)

			// throwInternalError carries an http extension, so this one leaves as a real 500 —
			// unlike the validator-driven failures above, which Apollo answers 200-with-errors.
			expect(status).toBe(500)
			expect(json.errors?.[0]?.message).toBe('Internal Server Error')
			expect(json.data?.imprenditoreDel).toBeUndefined()

			expect(await db().collection('imprenditore').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * Both mutations really write. Two separate bugs used to block every call, and both are fixed —
 * the tests below are the regression guard for each.
 *
 * 1. The shared `Imprenditore` model (marketplace-common) diverged from the collection validator:
 *    `anagrafica.nascita` was spelled `date` rather than `data`, `contatti` had no path at all,
 *    and the inline sub-objects picked up the implicit `_id` Mongoose adds by default. The
 *    migration's real `$jsonSchema` (20260301000100-create-imprenditore.js) declares both
 *    sub-objects under `additionalProperties: false` and requires `nascita.data` + `contatti`,
 *    while `GraphQLInputAnagraficaImprenditore` — the wire shape both mutations accept — sends
 *    exactly what the validator wants. Casting through the model therefore dropped `contatti` and
 *    rewrote `nascita` to a bare `{ _id }` before anything reached MongoDB, and the server refused
 *    the write. Fixed in marketplace-common 1.17.0, which brought the model back in step.
 *
 * 2. `imprenditoreAdd` handed `create()` a document with no `_id`. Every model in marketplace-common
 *    declares `_id` explicitly and without a default, which switches Mongoose's auto-generation
 *    off, so `create()` threw "document must have an _id before saving" without ever contacting
 *    MongoDB — a failure the first bug hid, since both surfaced as the same generic 500. Fixed by
 *    minting the id in the resolver, the line every other *Add resolver already carried.
 *
 * Both run over real HTTP against the real, migrated, validator-backed collection, so what they
 * assert is the document MongoDB actually accepted — not the one the model claims to emit.
 */
describe('imprenditoreAdd / imprenditoreUpdate mutations', () => {
	it('imprenditoreAdd: creates the imprenditore, nascita.data and contatti intact through the real validator', async () => {
		const session = await withSession()
		const email = `itest-${randomUUID()}@marketplace.invalid`
		const before = await db().collection('imprenditore').countDocuments()

		try {
			const { status, json } = await gql(
				`mutation {
					imprenditoreAdd(
						login: { email: "${email}", password: "${PASSWORD_HASH}" }
						anagrafica: {
							nome: "Mario"
							cognome: "Rossi"
							nascita: { data: "1980-01-01" }
							indirizzo: { indirizzo: "Via Test 1", cap: "24031", comune: "Almenno San Salvatore", provincia: "BG" }
							contatti: { cellulare: "3900000000", email: "${email}" }
						}
					)
				}`,
				session.headers
			)

			const created = await db().collection('imprenditore').findOne({ 'login.email': email })
			// Registered before the assertions: the row is already on the real collection, so a
			// failing expect below must still leave afterAll something to delete.
			if (created) seededIds.push(created._id)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditoreAdd).toBe(true)

			expect(created).not.toBeNull()
			expect(await db().collection('imprenditore').countDocuments()).toBe(before + 1)
			// The two paths the old model mangled, read back off the stored document.
			expect(created?.anagrafica.nascita).toEqual({ data: new Date('1980-01-01T00:00:00.000Z') })
			expect(created?.anagrafica.contatti).toEqual({ cellulare: '3900000000', email })
			// The resolver's own field, and the one that proves `_id` was minted before the insert.
			expect(created?.iscrizione).toBeInstanceOf(Date)
			expect(created?._id).toBeInstanceOf(mongoose.Types.ObjectId)
		} finally {
			await session.cleanup()
		}
	})

	it('imprenditoreUpdate: replaces the seeded anagrafica, nascita.data and contatti included', async () => {
		const session = await withSession()
		const { _id, email } = await seedImprenditore()

		try {
			const { status, json } = await gql(
				`mutation {
					imprenditoreUpdate(
						_id: "${_id.toHexString()}"
						anagrafica: {
							nome: "Updated"
							cognome: "Name"
							nascita: { data: "1985-06-15" }
							indirizzo: { indirizzo: "Via Nuova 2", cap: "24031", comune: "Almenno San Salvatore", provincia: "BG" }
							contatti: { cellulare: "3911111111", email: "${email}" }
						}
					)
				}`,
				session.headers
			)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditoreUpdate).toBe(true)

			// The whole `anagrafica` is replaced, so every field is the new one — and the two the old
			// model dropped are present rather than silently missing from a half-cast $set.
			const updated = await db().collection('imprenditore').findOne({ _id })
			expect(updated?.anagrafica.nome).toBe('Updated')
			expect(updated?.anagrafica.cognome).toBe('Name')
			expect(updated?.anagrafica.indirizzo.indirizzo).toBe('Via Nuova 2')
			expect(updated?.anagrafica.nascita).toEqual({ data: new Date('1985-06-15T00:00:00.000Z') })
			expect(updated?.anagrafica.contatti).toEqual({ cellulare: '3911111111', email })
		} finally {
			await session.cleanup()
		}
	})

	// The failure path of the same mutation: when the filter matches NO document, MongoDB writes
	// nothing and the $jsonSchema validator never runs. What answers the 500 here is
	// funImprenditoreUpdate's own `ret.modifiedCount !== 1` guard, driven by a genuine
	// matchedCount: 0 from the server — the same guard, and the same reasoning, as the
	// imprenditoreDel "_id matches no imprenditore" case above.
	it('imprenditoreUpdate: answers 500 via its own modifiedCount guard when the _id matches no imprenditore', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(
				`mutation {
					imprenditoreUpdate(
						_id: "${missing.toHexString()}"
						anagrafica: {
							nome: "Ghost"
							cognome: "Owner"
							nascita: { data: "1990-01-01" }
							indirizzo: { indirizzo: "Via Test 1", cap: "24031", comune: "Almenno San Salvatore", provincia: "BG" }
							contatti: { cellulare: "3922222222", email: "itest-ghost@marketplace.invalid" }
						}
					)
				}`,
				session.headers
			)

			expect(status).toBe(500)
			expect(json.errors?.[0]?.message).toBe('Internal Server Error')
			expect(await db().collection('imprenditore').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * The three field-level writes the detail page needs beyond `imprenditoreUpdate`.
 *
 * What only a live run can prove: that the dotted paths (`login.email`, `login.rememberMe`, …) reach the
 * document without the surrounding sub-object being replaced, that `$unset` really removes the key
 * rather than storing a null the `$jsonSchema` would refuse, and that the unique index on
 * `login.email` — which no mock can raise — comes back as a readable 409 instead of a 500.
 */
describe('imprenditoreUpdateEmail / imprenditoreUpdateStato / imprenditoreUpdatePreferenze mutations', () => {
	/** The `login` sub-document as MongoDB holds it. */
	async function login(_id: mongoose.Types.ObjectId) {
		const doc = await db().collection('imprenditore').findOne({ _id })

		return doc?.login as Record<string, unknown>
	}

	it('imprenditoreUpdateEmail: replaces login.email and leaves the rest of login untouched', async () => {
		const session = await withSession()
		const { _id } = await seedImprenditore()
		const nuova = `itest-nuova-${randomUUID()}@marketplace.invalid`

		// Seeded through the raw driver so there is something in `login` besides the two required
		// fields: a `{ login: { email } }` write would drop these, a `'login.email'` one keeps them.
		await db()
			.collection('imprenditore')
			.updateOne({ _id }, { $set: { 'login.rememberMe': true, 'login.onboardingStep': 'DATI' } })

		try {
			const { status, json } = await gql(
				`mutation { imprenditoreUpdateEmail(_id: "${_id.toHexString()}", email: "  ${nuova}  ") }`,
				session.headers
			)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditoreUpdateEmail).toBe(true)

			// Trimmed on the way in, and the other three keys are still there — `password` included,
			// which is the one whose loss would lock the account out for good.
			expect(await login(_id)).toEqual({
				email: nuova,
				password: PASSWORD_HASH,
				rememberMe: true,
				onboardingStep: 'DATI'
			})
		} finally {
			await session.cleanup()
		}
	})

	// The collection's only unique index, and the only rejection on this page a valid input can still
	// earn. Driven against the real index because that is the whole point: the helper's `code === 11000`
	// branch is unreachable without one.
	it('imprenditoreUpdateEmail: answers 409 when the address belongs to another imprenditore', async () => {
		const session = await withSession()
		const { _id, email } = await seedImprenditore()
		const altro = await seedImprenditore()

		try {
			const { status, json } = await gql(
				`mutation { imprenditoreUpdateEmail(_id: "${_id.toHexString()}", email: "${altro.email}") }`,
				session.headers
			)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(json.errors?.[0]?.extensions?.description).toBe('email: indirizzo già registrato da un altro imprenditore')

			// The rejected write left both documents as they were.
			expect((await login(_id)).email).toBe(email)
			expect((await login(altro._id)).email).toBe(altro.email)
		} finally {
			await session.cleanup()
		}
	})

	// The validator's reason for existing, end to end: without it a malformed address reaches the
	// collection and comes back as `Document failed validation` inside a 500.
	it('imprenditoreUpdateEmail: answers 400 with a readable reason, before touching the database', async () => {
		const session = await withSession()
		const { _id, email } = await seedImprenditore()

		try {
			const { status, json } = await gql(
				`mutation { imprenditoreUpdateEmail(_id: "${_id.toHexString()}", email: "nuova@marketplace") }`,
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('email: indirizzo email non valido')
			expect((await login(_id)).email).toBe(email)
		} finally {
			await session.cleanup()
		}
	})

	// `matchedCount`, not `modifiedCount` — the same missing id answers a 500 through
	// `imprenditoreUpdate` above, and that divergence is deliberate rather than an oversight.
	it('imprenditoreUpdateEmail: answers 404 when the _id matches no imprenditore', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(
				`mutation { imprenditoreUpdateEmail(_id: "${missing.toHexString()}", email: "itest-ghost@marketplace.invalid") }`,
				session.headers
			)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('imprenditore non trovato')
		} finally {
			await session.cleanup()
		}
	})

	// Both flags are absent-or-true in the collection, never `false`, so switching one off has to remove
	// the key. A `$set: { disabled: false }` would validate and read back as "not disabled" too — and
	// then `waitApprov: { $exists: true }`, which is how the approval queue is built, would list an
	// account nobody is waiting on.
	it('imprenditoreUpdateStato: stores both flags, then removes them rather than storing false', async () => {
		const session = await withSession()
		const { _id } = await seedImprenditore()

		function stato(disabled: boolean, waitApprov: boolean) {
			return gql(
				`mutation { imprenditoreUpdateStato(_id: "${_id.toHexString()}", disabled: ${disabled}, waitApprov: ${waitApprov}) }`,
				session.headers
			)
		}

		try {
			expect((await stato(true, true)).json.data?.imprenditoreUpdateStato).toBe(true)

			const acceso = await db().collection('imprenditore').findOne({ _id })
			expect(acceso?.disabled).toBe(true)
			expect(acceso?.waitApprov).toBe(true)

			expect((await stato(false, false)).json.errors).toBeUndefined()

			const spento = await db().collection('imprenditore').findOne({ _id })
			expect(spento).not.toHaveProperty('disabled')
			expect(spento).not.toHaveProperty('waitApprov')
		} finally {
			await session.cleanup()
		}
	})

	// The two booleans here behave the *opposite* way to the two above: `login.rememberMe` and
	// `login.onboardingDone` are declared `bool` and are stored as false, while `onboardingStep` is the
	// one optional string and is unset when the operator empties the box.
	it('imprenditoreUpdatePreferenze: stores false booleans and unsets a blank onboardingStep', async () => {
		const session = await withSession()
		const { _id, email } = await seedImprenditore()

		function preferenze(rememberMe: boolean, onboardingDone: boolean, step?: string) {
			return gql(
				`mutation {
					imprenditoreUpdatePreferenze(
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
			expect((await preferenze(true, false, 'DATI')).json.data?.imprenditoreUpdatePreferenze).toBe(true)
			expect(await login(_id)).toEqual({
				email,
				password: PASSWORD_HASH,
				rememberMe: true,
				onboardingDone: false,
				onboardingStep: 'DATI'
			})

			// A cleared text box arrives as blank, not as null, and has to leave the key absent —
			// `login.onboardingStep: null` fails `bsonType: 'string'` and takes the whole save with it.
			expect((await preferenze(false, true, '   ')).json.errors).toBeUndefined()
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

	it('imprenditoreUpdatePreferenze: answers 400 for an onboardingStep past the collection cap', async () => {
		const session = await withSession()
		const { _id } = await seedImprenditore()

		try {
			const { status, json } = await gql(
				`mutation { imprenditoreUpdatePreferenze(_id: "${_id.toHexString()}", rememberMe: true, onboardingDone: false, onboardingStep: "TROPPOLUNGO") }`,
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.extensions?.description).toBe('onboardingStep: massimo 4 caratteri')
			expect(await login(_id)).not.toHaveProperty('onboardingStep')
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * The first write on `puntoVendita` the operator tier has ever had.
 *
 * Everything the unit test has to take on trust is real here: the `2dsphere` that refuses a coordinate
 * pair in the wrong order, the `additionalProperties: false` that rejects a cleared optional sent as
 * null, the cross-collection company reference no foreign key enforces — and the `Time` scalar, which
 * parses `11:30:00Z` against *today's* date, so only the time half of what lands in the column is ever
 * assertable.
 *
 * The two unique indexes are gone from here: 20260803000100 dropped them and rebuilt them on `azienda`,
 * so the duplicate-key cases live in the `aziendaAdd` / `aziendaUpdate` describes below.
 */
describe('puntoVenditaUpdate mutation (real puntoVendita, real company reference)', () => {
	/**
	 * A complete, valid save. Two normalisations are baked into the literal rather than tested apart:
	 * the padded `nome` (trimmed), the blank `fisso` (dropped, not stored as '') and the lower-case
	 * `provincia` (upper-cased). `position` carries coordinates only — the input type has no `type`
	 * field, the validator writes `'Point'` itself. `idAzienda` is an id now, not an object.
	 */
	function saveMutation(_id: string, idAzienda: string, orari = '{ giorno: "Lun", da: "11:30:00Z", a: "15:00:00Z" }') {
		return `mutation {
			puntoVenditaUpdate(
				_id: "${_id}"
				nome: "  Insegna Aggiornata  "
				idAzienda: "${idAzienda}"
				indirizzo: {
					indirizzo: "Via Aggiornata 42"
					cap: "24030"
					comune: "Brembate di Sopra"
					provincia: "bg"
					position: { coordinates: [9.6, 45.72] }
				}
				contatti: { cellulare: "3933333333", web: "https://marketplace.test", fisso: "   " }
				orari: [${orari}]
			)
		}`
	}

	it('replaces the insegna, the company reference and the three sub-documents in one write, leaving idImprenditore and inserted alone', async () => {
		const session = await withSession()
		const { owner, puntoVendita } = await seedCatena()
		const { _id } = puntoVendita
		// A second company of the same owner: re-pointing the shop is part of what this write does, and
		// saving it at the id it already carries would prove nothing about the `$set`.
		const altra = await seedAzienda(owner._id)
		const prima = await db().collection('puntoVendita').findOne({ _id })

		try {
			const { status, json } = await gql(saveMutation(_id.toHexString(), altra._id.toHexString()), session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.puntoVenditaUpdate).toBe(true)

			const dopo = await db().collection('puntoVendita').findOne({ _id })

			// Both plain top-level values, both overwritten field-for-field. The insegna is trimmed like
			// every other required string; the company reference is stored as a real ObjectId and not as
			// the hex string the GraphQL `ID` scalar delivered, which is what `mongoose` casts for us and
			// what a `$lookup` or a `find({ idAzienda })` would otherwise silently miss. It lands under
			// `idAzienda` and nowhere else — an `azienda` key would fail `additionalProperties: false`.
			expect(dopo?.nome).toBe('Insegna Aggiornata')
			expect(dopo?.idAzienda).toEqual(altra._id)
			expect(dopo?.azienda).toBeUndefined()

			// toEqual, not a field-by-field walk: `$set` of a whole sub-document replaces it, so what
			// matters as much as the new values is that `fisso` is simply not there.
			expect(dopo?.indirizzo).toEqual({
				indirizzo: 'Via Aggiornata 42',
				cap: '24030',
				comune: 'Brembate di Sopra',
				provincia: 'BG',
				position: { type: 'Point', coordinates: [9.6, 45.72] }
			})
			expect(dopo?.contatti).toEqual({ cellulare: '3933333333', web: 'https://marketplace.test' })

			// Only the time half is asserted: `GraphQLTime` combines the clock value with the date the
			// row was written, so the date part is whatever today happens to be.
			expect(dopo?.orari).toHaveLength(1)
			expect(dopo?.orari[0].giorno).toBe('Lun')
			expect((dopo?.orari[0].da as Date).toISOString().slice(11)).toBe('11:30:00.000Z')
			expect((dopo?.orari[0].a as Date).toISOString().slice(11)).toBe('15:00:00.000Z')

			// Five `$set` keys and no more — ownership and the creation stamp are not the operator's to
			// rewrite, and a document-level replace would have taken both with it.
			expect(dopo?.idImprenditore).toEqual(owner._id)
			expect(dopo?.inserted).toEqual(prima?.inserted)
			expect(dopo?.disabled).toBe(false)
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ The company must belong to the shop's own owner, and the owner is read off the stored document
	 * rather than taken as an argument — so this is the one thing no unit test can prove for real: two
	 * imprenditori, one real company each, and the save that tries to file the first one's shop under the
	 * second one's legal entity. MongoDB enforces nothing here; the pre-flight `Azienda.exists` is the
	 * whole of it.
	 */
	it('answers 404 when the azienda belongs to a different imprenditore, and writes nothing', async () => {
		const session = await withSession()
		const { azienda, puntoVendita } = await seedCatena()
		const { _id } = puntoVendita
		const estraneo = await seedImprenditore()
		const aziendaAltrui = await seedAzienda(estraneo._id)

		try {
			const { status, json } = await gql(saveMutation(_id.toHexString(), aziendaAltrui._id.toHexString()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('azienda non trovata per questo imprenditore')

			// Nothing landed: the whole card is one `$set`, so a rejected write leaves the insegna, the
			// address and the hours as they were too.
			const invariato = await db().collection('puntoVendita').findOne({ _id })
			expect(invariato?.nome).toMatch(/^Itest Insegna /)
			expect(invariato?.idAzienda).toEqual(azienda._id)
			expect(invariato?.indirizzo.indirizzo).toBe('Via Test 1')
		} finally {
			await session.cleanup()
		}
	})

	it('answers 404 when the azienda id matches no company at all', async () => {
		const session = await withSession()
		const { puntoVendita } = await seedCatena()
		const mancante = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(saveMutation(puntoVendita._id.toHexString(), mancante.toHexString()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.extensions?.description).toBe('azienda non trovata per questo imprenditore')
		} finally {
			await session.cleanup()
		}
	})

	// One bad field rejects the whole save, and it does so before any of the three sub-documents is
	// written — which is the reason all of them are validated ahead of the single `funPuntoVenditaUpdate`
	// call rather than each one just before its own `$set`.
	it('answers 400 naming the offending path, and writes none of the other sub-documents', async () => {
		const session = await withSession()
		const { azienda, puntoVendita } = await seedCatena()
		const { _id } = puntoVendita

		try {
			const { status, json } = await gql(
				saveMutation(_id.toHexString(), azienda._id.toHexString(), '{ giorno: "   ", da: "11:30:00Z", a: "15:00:00Z" }'),
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('orari[0].giorno: campo obbligatorio')

			const invariato = await db().collection('puntoVendita').findOne({ _id })
			expect(invariato?.nome).toMatch(/^Itest Insegna /)
			expect(invariato?.contatti).toEqual({ cellulare: '3900000000' })
			expect(invariato?.orari).toEqual([])
		} finally {
			await session.cleanup()
		}
	})

	it('answers 404 when the _id matches no punto vendita', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(saveMutation(missing.toHexString(), azienda._id.toHexString()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('punto vendita non trovato')
			expect(await db().collection('puntoVendita').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})
})

describe('puntoVenditaAdd mutation (real write, real owner, real company reference)', () => {
	/**
	 * The same payload puntoVenditaUpdate is driven with, minus the `_id` and plus the owner, and with the
	 * same normalisations baked into the literal: padded `nome` (trimmed), blank `fisso` (dropped, not
	 * stored as ''), lower-case `provincia` (upper-cased). `position` carries coordinates only — the input
	 * type has no `type` field, the validator writes `'Point'`.
	 *
	 * `nome` is unique per call, and has to be: the mutation answers `Boolean!`, so the only way to find
	 * what it wrote is a value the payload guarantees. That used to be the partita IVA, which this
	 * mutation no longer carries.
	 */
	function addMutation(
		idImprenditore: string,
		idAzienda: string,
		nome: string,
		orari = '{ giorno: "Lun", da: "11:30:00Z", a: "15:00:00Z" }'
	) {
		return `mutation {
			puntoVenditaAdd(
				idImprenditore: "${idImprenditore}"
				nome: "  ${nome}  "
				idAzienda: "${idAzienda}"
				indirizzo: {
					indirizzo: "Via Nuova 7"
					cap: "24030"
					comune: "Brembate di Sopra"
					provincia: "bg"
					position: { coordinates: [9.6, 45.72] }
				}
				contatti: { cellulare: "3944444444", web: "https://nuova.marketplace.test", fisso: "   " }
				orari: [${orari}]
			)
		}`
	}

	function nomeItest() {
		return `Insegna Nuova ${randomUUID()}`
	}

	/**
	 * Registering the found document rather than only returning it is what keeps a successful insert from
	 * surviving the run: `afterAll` drains `seededPuntiVendita`, and a document nobody pushed into it
	 * stays in the database forever.
	 */
	async function creato(nome: string) {
		const doc = await db().collection('puntoVendita').findOne({ nome })

		if (doc !== null) seededPuntiVendita.push(doc._id)

		return doc
	}

	it('writes the insegna, the company reference and the three sub-documents under the named owner, minting the id and stamping inserted', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)
		const nome = nomeItest()

		try {
			const { status, json } = await gql(addMutation(owner._id.toHexString(), azienda._id.toHexString(), nome), session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.puntoVenditaAdd).toBe(true)

			const doc = await creato(nome)
			expect(doc?.idImprenditore).toEqual(owner._id)
			expect(doc?.inserted).toBeInstanceOf(Date)
			expect(doc?.nome).toBe(nome)
			// An ObjectId in the column, not the hex string the `ID` scalar delivered — the model casts
			// it, and the collection validator would refuse a string outright.
			expect(doc?.idAzienda).toEqual(azienda._id)
			expect(doc?.indirizzo).toEqual({
				indirizzo: 'Via Nuova 7',
				cap: '24030',
				comune: 'Brembate di Sopra',
				provincia: 'BG',
				position: { type: 'Point', coordinates: [9.6, 45.72] }
			})
			expect(doc?.contatti).toEqual({ cellulare: '3944444444', web: 'https://nuova.marketplace.test' })
			// Time of day only, same as puntoVenditaUpdate: `11:30:00Z` carries no date, so the day part
			// is whatever the parse ran on and asserting it would fail tomorrow.
			expect(doc?.orari).toHaveLength(1)
			expect(doc?.orari[0].giorno).toBe('Lun')
			expect((doc?.orari[0].da as Date).toISOString().slice(11)).toBe('11:30:00.000Z')
			expect((doc?.orari[0].a as Date).toISOString().slice(11)).toBe('15:00:00.000Z')
			// Nothing else reached the collection — `disabled` and `disabledByAdmin` in particular. A new
			// shop is open, and both switches stay puntoVenditaUpdateStato's business. The mongoose
			// version key rides along because the model declares it and the validator allows it.
			expect(Object.keys(doc ?? {}).sort()).toEqual([
				'__v',
				'_id',
				'contatti',
				'idAzienda',
				'idImprenditore',
				'indirizzo',
				'inserted',
				'nome',
				'orari'
			])
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ MongoDB has no foreign key, so this is the only thing standing between a mistyped id and a shop
	 * nobody can reach: `imprenditorePuntiVendita` lists strictly by owner, so a document filed under an
	 * id no imprenditore carries is visible only through the same wrong id that created it.
	 */
	it('answers 404 for an owner that does not exist, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)
		const missing = new mongoose.Types.ObjectId()
		const nome = nomeItest()

		try {
			const { status, json } = await gql(addMutation(missing.toHexString(), azienda._id.toHexString(), nome), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('imprenditore non trovato')
			expect(await creato(nome)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	// Soft-deleted counts as absent, over the wire and against the real filter: `funImprenditoreDelete`
	// stamps the owner and leaves its shops where they are, so a shop added afterwards would belong to
	// someone the platform has already removed.
	it('answers 404 for a soft-deleted owner, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedImprenditore({ deleted: new Date() })
		const azienda = await seedAzienda(owner._id)
		const nome = nomeItest()

		try {
			const { status, json } = await gql(addMutation(owner._id.toHexString(), azienda._id.toHexString(), nome), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.extensions?.description).toBe('imprenditore non trovato')
			expect(await creato(nome)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ The company is checked against the owner in one query, so this covers both halves of the pair
	 * being wrong at once — and the interesting half is the one that exists. A real company belonging to
	 * somebody else is what a stale `<select>` or a hand-made request produces, and attaching one
	 * imprenditore's shop to another's legal entity is not a state any read path could untangle.
	 */
	it('answers 404 when the azienda belongs to a different imprenditore, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const estraneo = await seedImprenditore()
		const aziendaAltrui = await seedAzienda(estraneo._id)
		const nome = nomeItest()

		try {
			const { status, json } = await gql(
				addMutation(owner._id.toHexString(), aziendaAltrui._id.toHexString(), nome),
				session.headers
			)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('azienda non trovata per questo imprenditore')
			expect(await creato(nome)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	// All three sub-documents are validated before any of them is written, so a single bad opening time
	// costs the whole insert rather than leaving a shop with no hours behind.
	it('rejects the whole insert when one field is invalid, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)
		const nome = nomeItest()

		try {
			const { status, json } = await gql(
				addMutation(
					owner._id.toHexString(),
					azienda._id.toHexString(),
					nome,
					'{ giorno: "   ", da: "11:30:00Z", a: "15:00:00Z" }'
				),
				session.headers
			)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('orari[0].giorno: campo obbligatorio')
			expect(await creato(nome)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})
})

describe('imprenditorePuntiVendita query (real puntoVendita under a real imprenditore)', () => {
	// What a live seed adds over the unit test is proof this is really how the real,
	// validator-backed `puntoVendita` collection answers the query, not an artifact of a mocked
	// `find()`. The negative half matters as much as the positive one: the resolver used to filter
	// on `_id`, so it answered [] for every genuine owner, and only a query whose argument happened
	// to be a punto vendita's own primary key ever returned a row. Asserting both directions is what
	// stops that swap from coming back unnoticed.
	it('returns the shops of the imprenditore whose id is passed, and nothing for a foreign id', async () => {
		const session = await withSession()
		const { owner, azienda, puntoVendita } = await seedCatena()
		const { _id: idPuntoVendita } = puntoVendita

		try {
			const byRealOwner = await gql(
				// `position` is asked for on purpose: GraphQLPositionFrag types `coordinates` as
				// [Float!]!, and the resolver hands the scalar what the driver deserialized. Under
				// the old [Int!]! this whole query answered an error — 9.57 is not an Int.
				//
				// `azienda` is asked for on purpose too, and is the whole reason this query is worth
				// running against real infrastructure now: since 20260803000100 the column holds an id and
				// the field is served by `funAziendaById`, a second query per shop that no unit test with
				// a mocked model can prove ever runs.
				`{ imprenditorePuntiVendita(idImprenditore: "${owner._id.toHexString()}") { _id nome azienda { _id idImprenditore ragionesociale } contatti { cellulare } indirizzo { position { type coordinates } } } }`,
				session.headers
			)
			expect(byRealOwner.json.errors).toBeUndefined()
			expect(byRealOwner.json.data?.imprenditorePuntiVendita).toEqual([
				{
					_id: idPuntoVendita.toHexString(),
					// Both asked for and both served: the insegna the card titles itself with, and the
					// ragione sociale of the company that owns the shop. They are not the same string in
					// the seed either, which is what makes this assertion worth making.
					nome: expect.stringMatching(/^Itest Insegna /),
					azienda: {
						_id: azienda._id.toHexString(),
						idImprenditore: owner._id.toHexString(),
						ragionesociale: azienda.ragionesociale
					},
					contatti: { cellulare: '3900000000' },
					indirizzo: { position: { type: 'Point', coordinates: [9.57, 45.75] } }
				}
			])

			// The shop's own _id is exactly the value the old filter matched on. It is not an owner
			// id, so the fixed resolver must find nothing for it.
			const byPuntoVenditaOwnId = await gql(
				`{ imprenditorePuntiVendita(idImprenditore: "${idPuntoVendita.toHexString()}") { _id } }`,
				session.headers
			)
			expect(byPuntoVenditaOwnId.json.errors).toBeUndefined()
			expect(byPuntoVenditaOwnId.json.data?.imprenditorePuntiVendita).toEqual([])
		} finally {
			await session.cleanup()
		}
	})

	// `deleted: trusted({ $exists: false })` asserted against the real collection rather than a mock
	// filter object: soft-deleted shops must drop out of the owner's list, not merely be requested to.
	it('omits a soft-deleted punto vendita from its owner list', async () => {
		const session = await withSession()
		const { owner, azienda, puntoVendita } = await seedCatena()
		const { _id: idLive } = puntoVendita
		// Both shops under the same company, which is the cardinality the extraction exists for.
		const { _id: idDeleted } = await seedPuntoVendita(owner._id, azienda._id)

		await db()
			.collection('puntoVendita')
			.updateOne({ _id: idDeleted }, { $set: { deleted: new Date() } })

		try {
			const { json } = await gql(
				`{ imprenditorePuntiVendita(idImprenditore: "${owner._id.toHexString()}") { _id } }`,
				session.headers
			)
			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditorePuntiVendita).toEqual([{ _id: idLive.toHexString() }])
		} finally {
			await session.cleanup()
		}
	})
})

/**
 * The `azienda` collection, created by 20260803000000 and written for the first time here.
 *
 * This is where the two unique indexes went. They were `puntoVendita.azienda.piva_unique` and
 * `…pec_unique`, they made a company's second shop impossible, and 20260803000100 dropped them and
 * rebuilt them on the collection where one row really is one company — so the duplicate-key cases below
 * are the same rule as before, finally asserted somewhere it is true.
 *
 * Both are plain global unique indexes, with no `partialFilterExpression` excluding the soft-deleted —
 * the same shape `imprenditore.login.email_unique` has. That is a decision, not an oversight: a deleted
 * company keeps its partita IVA occupied, and the `aziendaDel` block asserts it.
 */
describe('azienda mutations (real azienda collection, real unique indexes)', () => {
	/**
	 * A complete, valid company. Three normalisations are baked into the literal rather than tested
	 * apart: the padded `ragionesociale` (trimmed), the blank `cf` and blank `univoco` (dropped, not
	 * stored as ''), and the lower-case `provincia` (upper-cased). `position` carries coordinates only,
	 * exactly as on the shop form — the input type has no `type` field.
	 */
	function inputAzienda(piva: string, pec: string, cf = '   ', univoco = '   ') {
		return `{
			ragionesociale: "  Pizzeria Nuova S.r.l.  "
			piva: "${piva}"
			cf: "${cf}"
			referente: "Nuovo Referente"
			amministratore: "Nuovo Amministratore"
			univoco: "${univoco}"
			pec: "${pec}"
			indirizzo: {
				indirizzo: "Via Nuova 7"
				cap: "24030"
				comune: "Brembate di Sopra"
				provincia: "bg"
				position: { coordinates: [9.6, 45.72] }
			}
			visura: "visura-nuova"
		}`
	}

	function addMutation(idImprenditore: string, piva: string, pec: string, cf?: string, univoco?: string) {
		return `mutation {
			aziendaAdd(idImprenditore: "${idImprenditore}", azienda: ${inputAzienda(piva, pec, cf, univoco)})
		}`
	}

	function updateMutation(_id: string, piva: string, pec: string, cf?: string, univoco?: string) {
		return `mutation { aziendaUpdate(_id: "${_id}", azienda: ${inputAzienda(piva, pec, cf, univoco)}) }`
	}

	function pecItest() {
		return `itest-azienda-${randomUUID()}@pec.invalid`
	}

	/**
	 * The mutation answers `Boolean!`, so the caller never learns the new id — the company is found by
	 * its partita IVA, the one value the index guarantees unique. Registering it here rather than in each
	 * test is what keeps a successful insert from surviving the run: `afterAll` drains `seededAziende`,
	 * and a document nobody pushed into it stays in the database forever, holding its piva against every
	 * later run.
	 */
	async function creata(piva: string) {
		const doc = await db().collection('azienda').findOne({ piva })

		if (doc !== null) seededAziende.push(doc._id)

		return doc
	}

	it('aziendaAdd: writes the company under the named owner, minting the id and dropping the blank optionals', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const piva = pivaItest()
		const pec = pecItest()

		try {
			const { status, json } = await gql(addMutation(owner._id.toHexString(), piva, pec), session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.aziendaAdd).toBe(true)

			const doc = await creata(piva)
			expect(doc?.idImprenditore).toEqual(owner._id)
			expect(doc?.ragionesociale).toBe('Pizzeria Nuova S.r.l.')
			expect(doc?.indirizzo).toEqual({
				indirizzo: 'Via Nuova 7',
				cap: '24030',
				comune: 'Brembate di Sopra',
				provincia: 'BG',
				position: { type: 'Point', coordinates: [9.6, 45.72] }
			})
			// ⚠️ `cf` and `univoco` are ABSENT, not empty. Both were sent blank, and the collection's
			// `additionalProperties: false` plus `bsonType: 'string'` means a cleared box written as null
			// — which is what GraphQL serialises it to — fails the whole insert. The mongoose version key
			// rides along because the model declares it and the validator allows it.
			expect(Object.keys(doc ?? {}).sort()).toEqual([
				'__v',
				'_id',
				'amministratore',
				'idImprenditore',
				'indirizzo',
				'pec',
				'piva',
				'ragionesociale',
				'referente',
				'visura'
			])
		} finally {
			await session.cleanup()
		}
	})

	// The other side of the same rule: sent with a value, both optionals land. `cf` is the field the
	// extraction added — no stored company predating it carries one — and eleven characters is its only
	// constraint, on the collection and in the validator alike.
	it('aziendaAdd: stores cf and univoco when they carry a value', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const piva = pivaItest()

		try {
			const { json } = await gql(
				addMutation(owner._id.toHexString(), piva, pecItest(), '12345678901', 'ABC1234'),
				session.headers
			)

			expect(json.errors).toBeUndefined()

			const doc = await creata(piva)
			expect(doc?.cf).toBe('12345678901')
			expect(doc?.univoco).toBe('ABC1234')
		} finally {
			await session.cleanup()
		}
	})

	// Same owner check as puntoVenditaAdd, and for the same reason: `imprenditoreAziende` lists strictly
	// by owner, so a company filed under an id no imprenditore carries is reachable only through the same
	// wrong id that created it.
	it('aziendaAdd: answers 404 for an owner that does not exist, and writes nothing', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()
		const piva = pivaItest()

		try {
			const { status, json } = await gql(addMutation(missing.toHexString(), piva, pecItest()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('imprenditore non trovato')
			expect(await creata(piva)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	it('aziendaAdd: answers 404 for a soft-deleted owner, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedImprenditore({ deleted: new Date() })
		const piva = pivaItest()

		try {
			const { status, json } = await gql(addMutation(owner._id.toHexString(), piva, pecItest()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.extensions?.description).toBe('imprenditore non trovato')
			expect(await creata(piva)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * ⚠️ Enforced by MongoDB itself, not by a pre-flight read: two operators saving the same partita IVA
	 * at once both pass any check the service could make, and only the index refuses the second one. The
	 * second owner is a DIFFERENT imprenditore on purpose — `piva_unique` is global, not per owner, which
	 * is the scope it had on `puntoVendita` and the scope it keeps.
	 */
	it('aziendaAdd: answers 409 when the partita IVA is already registered, whoever owns it', async () => {
		const session = await withSession()
		const primo = await seedImprenditore()
		const secondo = await seedImprenditore()
		const piva = pivaItest()

		try {
			expect((await gql(addMutation(primo._id.toHexString(), piva, pecItest()), session.headers)).status).toBe(200)
			await creata(piva)

			const { status, json } = await gql(addMutation(secondo._id.toHexString(), piva, pecItest()), session.headers)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(json.errors?.[0]?.extensions?.description).toBe('partita IVA o PEC già registrate da un’altra azienda')
			expect(await db().collection('azienda').countDocuments({ piva })).toBe(1)
		} finally {
			await session.cleanup()
		}
	})

	// The second unique index, driven separately: the message names both candidates precisely because the
	// driver's error does not say which one fired, and a test that only ever trips `piva_unique` would
	// leave `pec_unique` unproven while the message kept claiming it.
	it('aziendaAdd: answers 409 when the PEC is already registered', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const pec = pecItest()
		const primaPiva = pivaItest()
		const secondaPiva = pivaItest()

		try {
			expect((await gql(addMutation(owner._id.toHexString(), primaPiva, pec), session.headers)).status).toBe(200)
			await creata(primaPiva)

			const { status, json } = await gql(addMutation(owner._id.toHexString(), secondaPiva, pec), session.headers)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.extensions?.description).toBe('partita IVA o PEC già registrate da un’altra azienda')
			expect(await creata(secondaPiva)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	// The path prefix is `azienda.` because the fields arrive inside one input object, and the operator
	// reads that path to find the box. `cf` is the field to prove it with: it is the one the extraction
	// added, and its rule — exactly eleven characters — is neither a max nor a min alone.
	it('aziendaAdd: answers 400 naming the prefixed path, and writes nothing', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const piva = pivaItest()

		try {
			const { status, json } = await gql(addMutation(owner._id.toHexString(), piva, pecItest(), '1234567890'), session.headers)

			expect(status).toBe(400)
			expect(json.errors?.[0]?.message).toBe('Bad Request')
			expect(json.errors?.[0]?.extensions?.description).toBe('azienda.cf: esattamente 11 caratteri')
			expect(await creata(piva)).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	it('aziendaUpdate: replaces every editable field in one write, leaving idImprenditore alone', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)
		const piva = pivaItest()
		const pec = pecItest()

		try {
			const { status, json } = await gql(updateMutation(azienda._id.toHexString(), piva, pec), session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.aziendaUpdate).toBe(true)

			const dopo = await db().collection('azienda').findOne({ _id: azienda._id })
			expect(dopo?.ragionesociale).toBe('Pizzeria Nuova S.r.l.')
			expect(dopo?.piva).toBe(piva)
			expect(dopo?.pec).toBe(pec)
			expect(dopo?.indirizzo.comune).toBe('Brembate di Sopra')
			// ⚠️ The owner is not in the `$set` and cannot be: `IAziendaValidata` has no `idImprenditore`
			// and `GraphQLInputAzienda` has no field for it. Reassigning a company would strand every shop
			// pointing at it under an imprenditore that no longer owns the company.
			expect(dopo?.idImprenditore).toEqual(owner._id)
		} finally {
			await session.cleanup()
		}
	})

	it('aziendaUpdate: answers 409 when the new partita IVA belongs to another company', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const altra = await seedAzienda(owner._id)
		const azienda = await seedAzienda(owner._id)
		const presa = (await db().collection('azienda').findOne({ _id: altra._id }))?.piva as string

		try {
			const { status, json } = await gql(updateMutation(azienda._id.toHexString(), presa, pecItest()), session.headers)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(json.errors?.[0]?.extensions?.description).toBe('partita IVA o PEC già registrate da un’altra azienda')

			// Nothing landed: the whole card is one `$set`, so a rejected write leaves the ragione sociale
			// and the seat as they were too.
			const invariata = await db().collection('azienda').findOne({ _id: azienda._id })
			expect(invariata?.ragionesociale).toMatch(/^Itest Pizzeria /)
			expect(invariata?.indirizzo.indirizzo).toBe('Via Test 1')
		} finally {
			await session.cleanup()
		}
	})

	it('aziendaUpdate: answers 404 when the _id matches no company', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(updateMutation(missing.toHexString(), pivaItest(), pecItest()), session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('azienda non trovata')
			expect(await db().collection('azienda').findOne({ _id: missing })).toBeNull()
		} finally {
			await session.cleanup()
		}
	})

	/*
	 * A soft delete, like every other delete on this tier: the row stays and gains a `deleted` instant.
	 * The referential check runs first all the same — a company retired while a shop still names it would
	 * leave `GraphQLPuntoVendita.azienda` resolving a 404 on a non-null field, which reaches the operator
	 * as a 500 with nothing usable in it, and the row surviving does not help since `funAziendaById`
	 * filters the deleted out.
	 */
	it('aziendaDel: refuses while a live punto vendita still references the company', async () => {
		const session = await withSession()
		const { azienda } = await seedCatena()

		try {
			const { status, json } = await gql(`mutation { aziendaDel(_id: "${azienda._id.toHexString()}") }`, session.headers)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.message).toBe('Conflict')
			expect(json.errors?.[0]?.extensions?.description).toBe('azienda ancora collegata a uno o più punti vendita')
			expect((await db().collection('azienda').findOne({ _id: azienda._id }))?.deleted).toBeUndefined()
		} finally {
			await session.cleanup()
		}
	})

	// ⚠️ Live shops only. Counting the soft-deleted ones would make a company undeletable forever the
	// moment its last shop was deleted — the operator's normal path — and every read of that shop is
	// already filtered out by the same `deleted: { $exists: false }`, so the reference it leaves behind
	// is one nothing follows.
	//
	// The row itself is asserted whole: `deleted` is a Date the validator accepted — `Date.now()` is a
	// number in the resolver and only mongoose's cast makes it one — and nothing else moved, which is
	// what separates a soft delete from an `updateOne` that quietly rewrote the document.
	it('aziendaDel: stamps deleted once its only shop is soft-deleted, and keeps the row', async () => {
		const session = await withSession()
		const { owner, azienda, puntoVendita } = await seedCatena()

		await db()
			.collection('puntoVendita')
			.updateOne({ _id: puntoVendita._id }, { $set: { deleted: new Date() } })

		try {
			const prima = new Date()
			const { status, json } = await gql(`mutation { aziendaDel(_id: "${azienda._id.toHexString()}") }`, session.headers)

			expect(status).toBe(200)
			expect(json.errors).toBeUndefined()
			expect(json.data?.aziendaDel).toBe(true)

			const dopo = await db().collection('azienda').findOne({ _id: azienda._id })
			expect(dopo).not.toBeNull()
			expect(dopo?.deleted).toBeInstanceOf(Date)
			expect((dopo?.deleted as Date).getTime()).toBeGreaterThanOrEqual(prima.getTime() - 1000)
			expect(dopo?.ragionesociale).toBe(azienda.ragionesociale)
			expect(dopo?.idImprenditore).toEqual(owner._id)
		} finally {
			await session.cleanup()
		}
	})

	// The company is gone from every read path the operator has, which is the whole of what "deleted"
	// means here — the row is still on disk and only the seed's own drain will remove it.
	it('aziendaDel: drops the company out of imprenditoreAziende', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const viva = await seedAzienda(owner._id)
		const morta = await seedAzienda(owner._id)

		try {
			const { status } = await gql(`mutation { aziendaDel(_id: "${morta._id.toHexString()}") }`, session.headers)
			expect(status).toBe(200)

			const { json } = await gql(
				`{ imprenditoreAziende(idImprenditore: "${owner._id.toHexString()}") { _id } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditoreAziende).toEqual([{ _id: viva._id.toHexString() }])
		} finally {
			await session.cleanup()
		}
	})

	// ⚠️ The partita IVA stays taken. Both unique indexes are plain global ones — no
	// `partialFilterExpression` excluding the deleted, the same choice `imprenditore.login.email_unique`
	// makes — so retiring a company does not free its piva for a fresh registration. Asserted rather than
	// left implicit because it is the one user-visible cost of the soft delete, and because adding the
	// partial filter later would flip this case silently.
	it('aziendaDel: leaves the partita IVA registered, so the same one cannot be added again', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)
		const piva = (await db().collection('azienda').findOne({ _id: azienda._id }))?.piva as string

		try {
			expect((await gql(`mutation { aziendaDel(_id: "${azienda._id.toHexString()}") }`, session.headers)).status).toBe(200)

			const { status, json } = await gql(addMutation(owner._id.toHexString(), piva, pecItest()), session.headers)

			expect(status).toBe(409)
			expect(json.errors?.[0]?.extensions?.description).toBe('partita IVA o PEC già registrate da un’altra azienda')
			expect(await db().collection('azienda').countDocuments({ piva })).toBe(1)
		} finally {
			await session.cleanup()
		}
	})

	// A second call finds the row, matches it and stamps it again. There is no `deleted` clause on the
	// write — the same shape `funPuntoVenditaDelete` has — so this is idempotent in effect, not a 404.
	it('aziendaDel: answers 200 again on an already deleted company', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)

		try {
			expect((await gql(`mutation { aziendaDel(_id: "${azienda._id.toHexString()}") }`, session.headers)).status).toBe(200)

			const { status, json } = await gql(`mutation { aziendaDel(_id: "${azienda._id.toHexString()}") }`, session.headers)

			expect(status).toBe(200)
			expect(json.data?.aziendaDel).toBe(true)
			expect((await db().collection('azienda').findOne({ _id: azienda._id }))?.deleted).toBeInstanceOf(Date)
		} finally {
			await session.cleanup()
		}
	})

	it('aziendaDel: answers 404 when the _id matches no company', async () => {
		const session = await withSession()
		const missing = new mongoose.Types.ObjectId()

		try {
			const { status, json } = await gql(`mutation { aziendaDel(_id: "${missing.toHexString()}") }`, session.headers)

			expect(status).toBe(404)
			expect(json.errors?.[0]?.message).toBe('Oops')
			expect(json.errors?.[0]?.extensions?.description).toBe('azienda non trovata')
		} finally {
			await session.cleanup()
		}
	})
})

describe('imprenditoreAziende query (real azienda under a real imprenditore)', () => {
	// Every field of the type, over the wire, against the real validator-backed collection: this is the
	// query the shop form's `<select>` is populated from, so a field the resolver fails to project is a
	// box the operator cannot fill. `cf` and `univoco` come back null — the seed stores neither, which is
	// exactly the state every company predating the extraction is in.
	it('returns the companies of the imprenditore whose id is passed, and nothing for a foreign id', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const azienda = await seedAzienda(owner._id)

		try {
			const { json } = await gql(
				`{ imprenditoreAziende(idImprenditore: "${owner._id.toHexString()}") { _id idImprenditore ragionesociale piva cf referente amministratore univoco pec visura indirizzo { indirizzo cap comune provincia position { type coordinates } } } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect(json.data?.imprenditoreAziende).toEqual([
				{
					_id: azienda._id.toHexString(),
					idImprenditore: owner._id.toHexString(),
					ragionesociale: azienda.ragionesociale,
					piva: expect.stringMatching(/^\d{11}$/),
					cf: null,
					referente: 'Itest Referente',
					amministratore: 'Itest Amministratore',
					univoco: null,
					pec: `itest-${azienda._id.toHexString()}@pec.invalid`,
					visura: 'itest-visura',
					indirizzo: {
						indirizzo: 'Via Test 1',
						cap: '24031',
						comune: 'Almenno San Salvatore',
						provincia: 'BG',
						position: { type: 'Point', coordinates: [9.57, 45.75] }
					}
				}
			])

			// The company's own _id is not an owner id, so the query must find nothing for it — the same
			// swap `imprenditorePuntiVendita` was once shipped with.
			const byAziendaOwnId = await gql(
				`{ imprenditoreAziende(idImprenditore: "${azienda._id.toHexString()}") { _id } }`,
				session.headers
			)
			expect(byAziendaOwnId.json.errors).toBeUndefined()
			expect(byAziendaOwnId.json.data?.imprenditoreAziende).toEqual([])
		} finally {
			await session.cleanup()
		}
	})

	// Every company of that owner and no other's, which is what makes the list safe to render as the
	// shop form's `<select>`: an entry from another imprenditore would be an option that
	// `funPuntoVenditaAdd` refuses with a 404 the operator cannot act on.
	it('lists every company of the owner, and never another owner’s', async () => {
		const session = await withSession()
		const owner = await seedImprenditore()
		const prima = await seedAzienda(owner._id)
		const seconda = await seedAzienda(owner._id)
		const estraneo = await seedImprenditore()
		await seedAzienda(estraneo._id)

		try {
			const { json } = await gql(
				`{ imprenditoreAziende(idImprenditore: "${owner._id.toHexString()}") { _id } }`,
				session.headers
			)

			expect(json.errors).toBeUndefined()
			expect((json.data?.imprenditoreAziende as Array<{ _id: string }>).map((a) => a._id).sort()).toEqual(
				[prima._id.toHexString(), seconda._id.toHexString()].sort()
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
	const OLD = 'vecchiaPassword1'
	const NEW = 'nuovaPassword12'

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
			const { status, json } = await updatePwd(OLD, 'corta', session.headers)

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
