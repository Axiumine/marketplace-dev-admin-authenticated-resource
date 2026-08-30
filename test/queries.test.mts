import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAdminAuthenticatedResource } from '../src/lib/auth/IContextAdminAuthenticatedResource.mts'
import { rejection } from './errors.mts'

const findById = vi.fn()
const companyFind = vi.fn()
const itemFind = vi.fn()
const itemCategoryFind = vi.fn()
const shopOwnersStatsDb = vi.fn()
const shopOwnersPerPeriodDb = vi.fn()
const shopOwnersActiveTblDb = vi.fn()
const usersActiveTblDb = vi.fn()
const usersStatsDb = vi.fn()
const usersPerPeriodDb = vi.fn()
const funKeygripStatus = vi.fn()
const captureException = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { findById }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({ Item: { find: itemFind } }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ItemCategory', () => ({
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
// Same shape, same reason. The customers table is the shop-owner one minus `search`, so the mock
// carries the default limit and nothing else — its real value is asserted through the schema.
vi.mock('@lib/user/usersActiveTblDb.mjs', () => ({
	default: usersActiveTblDb,
	USERS_TBL_DEFAULT_LIMIT: 25
}))
vi.mock('@lib/user/usersStatsDb.mjs', () => ({ default: usersStatsDb }))
vi.mock('@lib/user/usersPerPeriodDb.mjs', () => ({ default: usersPerPeriodDb }))
vi.mock('@lib/keygrip/funKeygripStatus.mjs', () => ({ funKeygripStatus }))
// tryCatchRethrow is NOT mocked, as in mutations.test.mts — only its Sentry sink is, so a failure
// really travels through the wrapper this resolver puts around the lib.
vi.mock('@sentry/node', () => ({ captureException }))

const { shopOwnerCompanies } = await import('../src/graphQLApi/schema/queries/shopOwnerCompanies.mts')
const { shopOwnerById } = await import('../src/graphQLApi/schema/queries/shopOwnerById.mts')
const { shopOwnersActiveTbl } = await import('../src/graphQLApi/schema/queries/shopOwnersActiveTbl.mts')
const { usersActiveTbl } = await import('../src/graphQLApi/schema/queries/usersActiveTbl.mts')
const { shopOwnersPerPeriod } = await import('../src/graphQLApi/schema/queries/shopOwnersPerPeriod.mts')
const { shopOwnersStats } = await import('../src/graphQLApi/schema/queries/shopOwnersStats.mts')
const { usersPerPeriod } = await import('../src/graphQLApi/schema/queries/usersPerPeriod.mts')
const { usersStats } = await import('../src/graphQLApi/schema/queries/usersStats.mts')
const { infoAdminAfterLogin } = await import('../src/graphQLApi/schema/queries/infoAdminAfterLogin.mts')
const { companyItems } = await import('../src/graphQLApi/schema/queries/companyItems.mts')
const { itemCategories } = await import('../src/graphQLApi/schema/queries/itemCategories.mts')
const { keygripStatus } = await import('../src/graphQLApi/schema/queries/keygripStatus.mts')

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
				'registeredAt personalData waitApprov notes resetPwd disabled disabledBy disabledReason deleted'
		)
	})

	// ⚠️ The verbatim assertion above cannot tell a real path from a misspelt one — it only says the
	// string did not change, and the string was wrong: `note` for `notes`, which Mongoose drops from a
	// projection without a word, leaving the admin note reading as blank in the admin UI. This test
	// asks the schema instead. `personalData` and `resetPwd` are sub-documents named as a whole, so
	// `path()` answers for them too; the `login.*` half is checked by the same call on the nested path.
	it('names only real paths on ShopOwner, so no field can be projected into silence', async () => {
		// The model is mocked at the top of this file down to a bare `findById`, so the real schema has
		// to be pulled in past the mock. This is the only test here that needs the actual shape.
		const { ShopOwner } = await vi.importActual<{ ShopOwner: { schema: { path(p: string): unknown } } }>(
			'@axiumine/marketplace-common/models/MongoDB/ShopOwner'
		)
		const doc = { _id }
		const builder = chain(doc, true)
		findById.mockReturnValueOnce(builder)

		await expect(shopOwnerById.resolve(null, { idShopOwner: _id })).resolves.toBe(doc)

		const projection = builder.select?.mock.calls[0]?.[0] as string

		// Field by field rather than in bulk, and the field name carried into the assertion: a failure
		// has to say *which* token is not a path, not that one of fourteen is not. `schema.path()`
		// answers for a nested path like `login.email` and for a sub-document named whole, and answers
		// `undefined` for anything the collection has never heard of — which is the whole check.
		for (const field of projection.split(' '))
			expect({ field, isRealPath: ShopOwner.schema.path(field) !== undefined }).toEqual({ field, isRealPath: true })
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
	// tier rather than an omission: an admin owns nothing, and moderating means reading somebody
	// else's catalogue. Drafts are in for the same reason — an unpublished item is still reportable, and
	// a moderator who only sees published items cannot act before the owner publishes.
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

	// No args and no paging: an admin writes this list and nobody else can, so it is bounded by hand,
	// and the screen needs every category at once to render parents with their children under them.
	//
	// The sort is part of the contract, not a nicety — `position` is the admin's chosen order and is
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

		const args = {
			offset: 25,
			limit: 10,
			disabled: true,
			deleted: true,
			search: 'ros',
			sortBy: 'LAST_NAME',
			sortDir: 'ASC'
		} as const

		await expect(shopOwnersActiveTbl.resolve(null, args)).resolves.toBe(page)
		expect(shopOwnersActiveTblDb).toHaveBeenCalledExactlyOnceWith(args)
	})
})

describe('usersActiveTbl', () => {
	beforeEach(() => usersActiveTblDb.mockReset())

	// A pass-through, asserted as one — same contract as `shopOwnersActiveTbl` above. Seven arguments
	// here too, three of them filters whose defaults decide what an admin sees on arrival, and
	// rebuilding the object field by field is where a second, drifting set of defaults would take
	// root.
	it('hands its arguments to the lib and returns the page untouched', async () => {
		const page = { items: [{ _id }], total: 1 }
		usersActiveTblDb.mockResolvedValueOnce(page)

		const args = {
			offset: 25,
			limit: 10,
			disabled: true,
			deleted: false,
			emailVerified: false,
			sortBy: 'REGISTERED_AT',
			sortDir: 'ASC'
		} as const

		await expect(usersActiveTbl.resolve(null, args)).resolves.toBe(page)
		expect(usersActiveTblDb).toHaveBeenCalledExactlyOnceWith(args)
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

describe('usersStats', () => {
	it('hands the count straight through', async () => {
		usersStatsDb.mockResolvedValueOnce(7)

		await expect(usersStats.resolve()).resolves.toBe(7)
	})
})

describe('usersPerPeriod', () => {
	// Same assertion as its shopOwner twin, and for the same reason: the argument is unwrapped and
	// passed positionally, so handing the lib the whole args object would still resolve the mocked
	// series and still type-check, while `RANGES[period]` answered undefined for every range at run
	// time. ⚠️ It also pins WHICH lib the resolver reaches — the two libs are two lines each over one
	// shared file, so a copy-paste that left `shopOwnersPerPeriodDb` here would draw shop owners on
	// the customers chart and pass every other test in this repo.
	it('unwraps the period argument and hands the series straight through', async () => {
		const series = { granularity: 'MONTH', points: [{ date: '2026-08-01', total: 3 }] }
		// Cleared here rather than in a `beforeEach`: this file resets nothing globally, and the twin
		// resolver's own test above has already called it.
		shopOwnersPerPeriodDb.mockClear()
		usersPerPeriodDb.mockResolvedValueOnce(series)

		await expect(usersPerPeriod.resolve(null, { period: 'ALL' })).resolves.toBe(series)

		expect(usersPerPeriodDb).toHaveBeenCalledExactlyOnceWith('ALL')
		expect(shopOwnersPerPeriodDb).not.toHaveBeenCalled()
	})
})

describe('keygripStatus', () => {
	beforeEach(() => {
		funKeygripStatus.mockReset()
		captureException.mockReset()
	})

	/*
	 * ⚠️ No arguments and no context: the record is the platform's, not the session's, and there is nothing
	 * about it a caller could name. The resolver hands back exactly what the lib built — a reshaping here
	 * would be a second place for a field to be added to, and the schema test that forbids `material` only
	 * guards the types.
	 */
	it('returns the answer the lib built, untouched', async () => {
		const status = { version: 3, fingerprint: 'c77808de4139', keys: [], holders: [] }
		funKeygripStatus.mockResolvedValueOnce(status)

		await expect(keygripStatus.resolve()).resolves.toBe(status)

		expect(funKeygripStatus).toHaveBeenCalledExactlyOnceWith()
	})

	// A record this service cannot open is a 500 that already carries what to fix — flattening it into a
	// second, generic one would lose the only sentence telling the admin whose `KEYGRIP_KEK` is wrong.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwConflictError } = await import('@axiumine/koa-utils/graphQL/throw/throwConflictError')
		funKeygripStatus.mockImplementationOnce(() => throwConflictError('the record moved under this read'))

		expect(await rejection(keygripStatus.resolve())).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'the record moved under this read'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('redis down')
		funKeygripStatus.mockRejectedValueOnce(error)

		await expect(keygripStatus.resolve()).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('infoAdminAfterLogin', () => {
	// Reads only what the middleware already put on the context — no MongoDB round-trip.
	it('echoes back the authenticated admin from ctx.state.user', async () => {
		const ctx = { state: { user: { _id, email: 'admin@marketplace.test' } } } as IContextAdminAuthenticatedResource

		await expect(infoAdminAfterLogin.resolve(null, {}, ctx)).resolves.toEqual({
			_id,
			email: 'admin@marketplace.test'
		})
	})
})
