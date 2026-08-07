import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAdminAuthenticatedResource } from '../src/lib/auth/IContextAdminAuthenticatedResource.mts'

const findById = vi.fn()
const companyFind = vi.fn()
const itemFind = vi.fn()
const itemCategoryFind = vi.fn()
const shopOwnersStatsDb = vi.fn()
const shopOwnersPerPeriodDb = vi.fn()
const shopOwnersActiveTblDb = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { findById }
}))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind }
}))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Item', () => ({ Item: { find: itemFind } }))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: { find: itemCategoryFind }
}))
vi.mock('@lib/shopOwner/shopOwnersStatsDb.mjs', () => ({ default: shopOwnersStatsDb }))
vi.mock('@lib/shopOwner/shopOwnersPerPeriodDb.mjs', () => ({ default: shopOwnersPerPeriodDb }))
// The default export is the query; the named constant is read by the resolver to build its `limit`
// argument's defaultValue, so the mock has to carry it too or the module shape is a lie. Its real
// value is asserted through the schema (test/schema.test.mts), not from here.
vi.mock('@lib/shopOwner/shopOwnersActiveTblDb.mjs', () => ({
	default: shopOwnersActiveTblDb,
	SHOP_OWNERS_TBL_DEFAULT_LIMIT: 25
}))

const { shopOwnerCompanies } = await import('../src/graphQLApi/schema/queries/shopOwnerCompanies.mts')
const { shopOwnerById } = await import('../src/graphQLApi/schema/queries/shopOwnerById.mts')
const { shopOwnersActiveTbl } = await import('../src/graphQLApi/schema/queries/shopOwnersActiveTbl.mts')
const { shopOwnersPerPeriod } = await import('../src/graphQLApi/schema/queries/shopOwnersPerPeriod.mts')
const { shopOwnersStats } = await import('../src/graphQLApi/schema/queries/shopOwnersStats.mts')
const { infoAdminAfterLogin } = await import('../src/graphQLApi/schema/queries/infoAdminAfterLogin.mts')
const { companyItems } = await import('../src/graphQLApi/schema/queries/companyItems.mts')
const { itemCategories } = await import('../src/graphQLApi/schema/queries/itemCategories.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** Query builders end in `.lean()`, some with a `.select()` in between. */
function chain(result: unknown, withSelect: boolean) {
	const lean = vi.fn().mockResolvedValue(result)
	return withSelect ? { select: vi.fn().mockReturnValue({ lean }), lean } : { lean }
}

describe('shopOwnerById', () => {
	beforeEach(() => findById.mockReset())

	// The projection is the query's contract with GraphQLShopOwnerById: a field dropped here
	// surfaces as a null on a NonNull and blows up the whole response, so it is asserted verbatim.
	it('projects exactly the fields the GraphQL type declares', async () => {
		const doc = { _id }
		const builder = chain(doc, true)
		findById.mockReturnValueOnce(builder)

		await expect(shopOwnerById.resolve(null, { idShopOwner: _id })).resolves.toBe(doc)

		expect(findById).toHaveBeenCalledExactlyOnceWith({ _id })
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(
			'_id login.email login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone login.rememberMe ' +
				'registeredAt personalData registeredAt waitApprov note resetPwd disabled deleted'
		)
	})
})

describe('shopOwnerCompanies', () => {
	beforeEach(() => companyFind.mockReset())

	// Owner and liveness. The `deleted` clause matters because this query draws the Companies `<select>`
	// a company-scoped form offers, so a deleted company left in would be pickable when it should not be.
	// `trusted()` is what keeps mongoose's global sanitizeFilter from rewriting the `$exists` clause into
	// a literal comparison that matches nothing — which would empty the box for every shopOwner.
	it('filters by the owning shopOwner and excludes the soft-deleted', async () => {
		const docs = [{ _id }]
		companyFind.mockReturnValueOnce(chain(docs, false))

		await expect(shopOwnerCompanies.resolve(null, { idShopOwner: _id })).resolves.toBe(docs)

		expect(companyFind).toHaveBeenCalledExactlyOnceWith({
			idShopOwner: _id,
			deleted: trusted({ $exists: false })
		})
	})
})

describe('companyItems', () => {
	beforeEach(() => itemFind.mockReset())

	// ⚠️ The same query the owner runs on 4026 **minus the ownership guard**, and the missing guard is the
	// tier rather than an omission: an operator owns nothing, and moderating means reading somebody
	// else's catalogue. Drafts are in for the same reason — an unpublished item is still reportable, and
	// a moderator who only sees published rows cannot act before the owner publishes.
	//
	// So the exact key set is the assertion: a `published: true` tidied in here would quietly halve what
	// moderation can see.
	it('lists one company’s live items, drafts included', async () => {
		const docs = [{ _id }]
		itemFind.mockReturnValueOnce(chain(docs, false))

		await expect(companyItems.resolve(null, { idCompany: _id })).resolves.toBe(docs)

		expect(itemFind).toHaveBeenCalledExactlyOnceWith({ idCompany: _id, deleted: trusted({ $exists: false }) })
	})
})

describe('itemCategories', () => {
	beforeEach(() => itemCategoryFind.mockReset())

	// No args and no paging: an operator writes this list and nobody else can, so it is bounded by hand,
	// and the screen needs every row at once to render parents with their children under them.
	//
	// The sort is part of the contract, not a nicety — `position` is the operator's chosen order and is
	// not unique, so without the `_id` tiebreak two categories sharing a position swap places between
	// calls and the screen reorders itself for no reason.
	it('lists the whole live taxonomy, flat, ordered by position then _id', async () => {
		const docs = [{ _id }]
		const lean = vi.fn().mockResolvedValue(docs)
		const sort = vi.fn().mockReturnValue({ lean })
		itemCategoryFind.mockReturnValueOnce({ sort })

		await expect(itemCategories.resolve()).resolves.toBe(docs)

		expect(itemCategoryFind).toHaveBeenCalledExactlyOnceWith({ deleted: trusted({ $exists: false }) })
		expect(sort).toHaveBeenCalledExactlyOnceWith({ position: 1, _id: 1 })
	})
})

describe('shopOwnersActiveTbl', () => {
	beforeEach(() => shopOwnersActiveTblDb.mockReset())

	// Paging, filtering and sorting all live in the lib, which has its own suite; the resolver is a
	// pass-through and is asserted as one. Both halves matter: forwarding the args OBJECT unchanged
	// (rather than rebuilding it field by field, which is where a second, drifting set of defaults
	// would take root) and returning the lib's page as-is, since `{ items, total }` is already the
	// shape GraphQLShopOwnersActiveTblPage declares.
	it('hands its arguments to the lib and returns the page untouched', async () => {
		const page = { items: [{ _id }], total: 1 }
		shopOwnersActiveTblDb.mockResolvedValueOnce(page)

		const args = { offset: 25, limit: 10, search: 'ros', sortBy: 'LAST_NAME', sortDir: 'ASC' } as const

		await expect(shopOwnersActiveTbl.resolve(null, args)).resolves.toBe(page)
		expect(shopOwnersActiveTblDb).toHaveBeenCalledExactlyOnceWith(args)
	})
})

describe('shopOwnersStats', () => {
	it('hands the count straight through', async () => {
		shopOwnersStatsDb.mockResolvedValueOnce(42)

		await expect(shopOwnersStats.resolve()).resolves.toBe(42)
	})
})

describe('shopOwnersPerPeriod', () => {
	// The argument is unwrapped and passed positionally, so the assertion is on what the lib was
	// CALLED with, not only on what came back: handing it the whole args object would still resolve
	// the mocked series and still type-check against `unknown`, while the lib's `RANGES[period]`
	// lookup would answer undefined for every range at run time.
	it('unwraps the period argument and hands the series straight through', async () => {
		const series = { granularity: 'DAY', points: [{ date: '2026-08-02', total: 1 }] }
		shopOwnersPerPeriodDb.mockResolvedValueOnce(series)

		await expect(shopOwnersPerPeriod.resolve(null, { period: 'ONE_MONTH' })).resolves.toBe(series)

		expect(shopOwnersPerPeriodDb).toHaveBeenCalledExactlyOnceWith('ONE_MONTH')
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
