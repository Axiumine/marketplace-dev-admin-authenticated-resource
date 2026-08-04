import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAdminAuthenticatedResource } from '../src/lib/auth/IContextAdminAuthenticatedResource.mts'

const findById = vi.fn()
const aziendaFind = vi.fn()
const imprenditoriStatsDb = vi.fn()
const imprenditoriPerPeriodoDb = vi.fn()
const imprenditoriAttiviTblDb = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore', () => ({
	Imprenditore: { findById }
}))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda', () => ({
	Azienda: { find: aziendaFind }
}))
vi.mock('@lib/imprenditore/imprenditoriStatsDb.mjs', () => ({ default: imprenditoriStatsDb }))
vi.mock('@lib/imprenditore/imprenditoriPerPeriodoDb.mjs', () => ({ default: imprenditoriPerPeriodoDb }))
// The default export is the query; the named constant is read by the resolver to build its `limit`
// argument's defaultValue, so the mock has to carry it too or the module shape is a lie. Its real
// value is asserted through the schema (test/schema.test.mts), not from here.
vi.mock('@lib/imprenditore/imprenditoriAttiviTblDb.mjs', () => ({
	default: imprenditoriAttiviTblDb,
	IMPRENDITORI_TBL_DEFAULT_LIMIT: 25
}))

const { imprenditoreAziende } = await import('../src/graphQLApi/schema/queries/imprenditoreAziende.mts')
const { imprenditoreById } = await import('../src/graphQLApi/schema/queries/imprenditoreById.mts')
const { imprenditoriAttiviTbl } = await import('../src/graphQLApi/schema/queries/imprenditoriAttiviTbl.mts')
const { imprenditoriPerPeriodo } = await import('../src/graphQLApi/schema/queries/imprenditoriPerPeriodo.mts')
const { imprenditoriStats } = await import('../src/graphQLApi/schema/queries/imprenditoriStats.mts')
const { infoAdminAfterLogin } = await import('../src/graphQLApi/schema/queries/infoAdminAfterLogin.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** Query builders end in `.lean()`, some with a `.select()` in between. */
function chain(result: unknown, withSelect: boolean) {
	const lean = vi.fn().mockResolvedValue(result)
	return withSelect ? { select: vi.fn().mockReturnValue({ lean }), lean } : { lean }
}

describe('imprenditoreById', () => {
	beforeEach(() => findById.mockReset())

	// The projection is the query's contract with GraphQLImprenditoreById: a field dropped here
	// surfaces as a null on a NonNull and blows up the whole response, so it is asserted verbatim.
	it('projects exactly the fields the GraphQL type declares', async () => {
		const doc = { _id }
		const builder = chain(doc, true)
		findById.mockReturnValueOnce(builder)

		await expect(imprenditoreById.resolve(null, { idImprenditore: _id })).resolves.toBe(doc)

		expect(findById).toHaveBeenCalledExactlyOnceWith({ _id })
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(
			'_id login.email login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone login.rememberMe ' +
				'iscrizione anagrafica iscrizione waitApprov note resetPwd disabled deleted'
		)
	})
})

describe('imprenditoreAziende', () => {
	beforeEach(() => aziendaFind.mockReset())

	// Owner and liveness. The `deleted` clause matters because this query draws the Aziende `<select>`
	// a company-scoped form offers, so a deleted company left in would be pickable when it should not be.
	// `trusted()` is what keeps mongoose's global sanitizeFilter from rewriting the `$exists` clause into
	// a literal comparison that matches nothing — which would empty the box for every imprenditore.
	it('filters by the owning imprenditore and excludes the soft-deleted', async () => {
		const docs = [{ _id }]
		aziendaFind.mockReturnValueOnce(chain(docs, false))

		await expect(imprenditoreAziende.resolve(null, { idImprenditore: _id })).resolves.toBe(docs)

		expect(aziendaFind).toHaveBeenCalledExactlyOnceWith({
			idImprenditore: _id,
			deleted: trusted({ $exists: false })
		})
	})
})

describe('imprenditoriAttiviTbl', () => {
	beforeEach(() => imprenditoriAttiviTblDb.mockReset())

	// Paging, filtering and sorting all live in the lib, which has its own suite; the resolver is a
	// pass-through and is asserted as one. Both halves matter: forwarding the args OBJECT unchanged
	// (rather than rebuilding it field by field, which is where a second, drifting set of defaults
	// would take root) and returning the lib's page as-is, since `{ items, total }` is already the
	// shape GraphQLImprenditoriAttiviTblPage declares.
	it('hands its arguments to the lib and returns the page untouched', async () => {
		const page = { items: [{ _id }], total: 1 }
		imprenditoriAttiviTblDb.mockResolvedValueOnce(page)

		const args = { offset: 25, limit: 10, search: 'ros', sortBy: 'COGNOME', sortDir: 'ASC' } as const

		await expect(imprenditoriAttiviTbl.resolve(null, args)).resolves.toBe(page)
		expect(imprenditoriAttiviTblDb).toHaveBeenCalledExactlyOnceWith(args)
	})
})

describe('imprenditoriStats', () => {
	it('hands the count straight through', async () => {
		imprenditoriStatsDb.mockResolvedValueOnce(42)

		await expect(imprenditoriStats.resolve()).resolves.toBe(42)
	})
})

describe('imprenditoriPerPeriodo', () => {
	// The argument is unwrapped and passed positionally, so the assertion is on what the lib was
	// CALLED with, not only on what came back: handing it the whole args object would still resolve
	// the mocked series and still type-check against `unknown`, while the lib's `RANGES[periodo]`
	// lookup would answer undefined for every range at run time.
	it('unwraps the periodo argument and hands the series straight through', async () => {
		const serie = { granularita: 'GIORNO', punti: [{ data: '2026-08-02', totale: 1 }] }
		imprenditoriPerPeriodoDb.mockResolvedValueOnce(serie)

		await expect(imprenditoriPerPeriodo.resolve(null, { periodo: 'UN_MESE' })).resolves.toBe(serie)

		expect(imprenditoriPerPeriodoDb).toHaveBeenCalledExactlyOnceWith('UN_MESE')
	})
})

describe('infoAdminAfterLogin', () => {
	// Reads only what the middleware already put on the context — no MongoDB round-trip.
	it('echoes back the authenticated admin from ctx.state.user', async () => {
		const ctx = { state: { user: { _id, email: 'operator@marketplace.test' } } } as IContextAdminAuthenticatedResource

		await expect(infoAdminAfterLogin.resolve(null, {}, ctx)).resolves.toEqual({
			_id,
			email: 'operator@marketplace.test'
		})
	})
})
