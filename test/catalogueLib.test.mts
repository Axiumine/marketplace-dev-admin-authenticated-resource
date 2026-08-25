import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const itemUpdateOne = vi.fn()
const itemCountDocuments = vi.fn()
const itemCategoryCreate = vi.fn()
const itemCategoryFindOneAndUpdate = vi.fn()
const itemCategoryUpdateOne = vi.fn()
const itemCategoryCountDocuments = vi.fn()

// `vi.hoisted`, unlike the plain consts above, because this file imports `mongoose` itself: the mock
// factory runs while that import is evaluated, which is before any top-level `const` here has been
// initialised. Same shape as `userMutations.test.mts` on 4027. The stand-in `withTransaction` runs the
// work it is handed exactly once — the retry a real one performs on a `WriteConflict` is asked for
// explicitly by the one test that needs it.
const { endSession, session, startSession, withTransaction } = vi.hoisted(() => {
	const endSessionFn = vi.fn()
	const withTransactionFn = vi.fn(async (work: () => Promise<void>) => await work())
	const sessionObj = { withTransaction: withTransactionFn, endSession: endSessionFn }

	return {
		endSession: endSessionFn,
		session: sessionObj,
		startSession: vi.fn(async () => sessionObj),
		withTransaction: withTransactionFn
	}
})

vi.mock('mongoose', async (importOriginal) => {
	const actual = await importOriginal<typeof import('mongoose')>()

	return { ...actual, default: { ...actual.default, startSession } }
})

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }))
// ⚠️ Neither mock carries `deleteOne`, for the reason `companyLib.test.mts` leaves it off Company:
// every delete on this tier is a stamp, and a regression to a hard removal has to fail here rather
// than against a real database. A call to a method the mock does not have throws — which is what also
// holds the parent check shut: `findOne` is deliberately absent, so reading the parent without writing
// it, the shape that reopens the write-skew window, throws instead of passing.
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({
	Item: { updateOne: itemUpdateOne, countDocuments: itemCountDocuments }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: {
		create: itemCategoryCreate,
		findOneAndUpdate: itemCategoryFindOneAndUpdate,
		updateOne: itemCategoryUpdateOne,
		countDocuments: itemCategoryCountDocuments
	}
}))

const { funItemDelete } = await import('../src/lib/item/funItemDelete.mts')
const { funItemUpdatePublished } = await import('../src/lib/item/funItemUpdatePublished.mts')
const { funItemCategoryAdd } = await import('../src/lib/itemCategory/funItemCategoryAdd.mts')
const { funItemCategoryDelete } = await import('../src/lib/itemCategory/funItemCategoryDelete.mts')
const { funItemCategoryUpdate } = await import('../src/lib/itemCategory/funItemCategoryUpdate.mts')
const { throwIfHasChildren } = await import('../src/lib/itemCategory/throwIfHasChildren.mts')
const { throwIfParentNotTopLevel } = await import('../src/lib/itemCategory/throwIfParentNotTopLevel.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439020')
const idParent = new Types.ObjectId('507f1f77bcf86cd799439030')

const itemExec = vi.fn()
const categoryExec = vi.fn()

/**
 * Every query the three category paths make now runs `.session(s)` before its `.lean()` or `.exec()`,
 * so the chain mocks are shaped that way and `threaded` collects what each one was handed. A source line
 * that drops the `.session()` reaches for a `.lean()` this mock does not have and fails here, rather than
 * committing on its own outside the transaction it was meant to join.
 *
 * `Item.updateOne` is the exception: the two item paths are single writes and open no session at all.
 */
const threaded: unknown[] = []

const sessioned = (tail: object) => ({
	session: vi.fn((clientSession: unknown) => {
		threaded.push(clientSession)

		return tail
	})
})

const counting = (found: number) => sessioned({ lean: vi.fn().mockResolvedValue(found) })
const finding = (doc: unknown) => sessioned({ lean: vi.fn().mockResolvedValue(doc) })

/** A category as `validateItemCategory` hands it over: top-level unless a parent is spread in. */
const data = { name: 'Footwear', slug: 'footwear', position: 0 } as never

/** The absence clause every read on this tier shares, tagged so `sanitizeFilter` leaves it alone. */
const live = trusted({ $exists: false })

/** The session the three write paths open, as the guards receive it — the mock is not a `ClientSession`. */
const inSession = session as never

beforeEach(() => {
	threaded.length = 0
	startSession.mockClear()
	withTransaction.mockClear()
	endSession.mockClear()
	itemUpdateOne.mockReset().mockReturnValue({ exec: itemExec })
	itemExec.mockReset().mockResolvedValue({ matchedCount: 1 })
	itemCountDocuments.mockReset().mockReturnValue(counting(0))
	itemCategoryCreate.mockReset().mockResolvedValue(undefined)
	itemCategoryFindOneAndUpdate.mockReset().mockReturnValue(finding({ _id: idParent }))
	itemCategoryUpdateOne.mockReset().mockReturnValue(sessioned({ exec: categoryExec }))
	categoryExec.mockReset().mockResolvedValue({ matchedCount: 1 })
	itemCategoryCountDocuments.mockReset().mockReturnValue(counting(0))
})

describe('funItemDelete', () => {
	// ⚠️ No ownership clause and no `deleted` clause, unlike the owner's `itemDel` on 4026 — an operator
	// owns nothing, and acting on somebody else's document is the whole tier. The exact key set is therefore
	// the assertion: an `idCompany` quietly copied in from the sibling service would make every
	// moderation delete a 404.
	it('stamps deleted on the item, by id alone', async () => {
		await expect(funItemDelete(_id)).resolves.toBeUndefined()

		const [filter, update] = itemUpdateOne.mock.calls[0]
		expect(itemUpdateOne).toHaveBeenCalledOnce()
		expect(filter).toEqual({ _id })
		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		// `Date.now()` is a number and the schema path is a Date; mongoose casts it, which is why the
		// assertion is on the type rather than on an instance of Date.
		expect(typeof update.$set.deleted).toBe('number')
	})

	it('answers 404 when the id names no item', async () => {
		itemExec.mockResolvedValueOnce({ matchedCount: 0 })

		expect(await rejection(funItemDelete(_id))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'item not found'
		})
	})
})

describe('funItemUpdatePublished', () => {
	// ⚠️ `false`, never `$unset`: `published` is in the collection's `required` array, so unsetting it
	// fails the write outright — which is the opposite of `shopOwner.disabled` next door, whose validator
	// wants it present-and-true or absent.
	it.each([
		['takes an item down', false],
		['puts it back', true]
	])('%s, writing the flag as a boolean', async (_label, published) => {
		await expect(funItemUpdatePublished(_id, published)).resolves.toBeUndefined()

		const [filter, update] = itemUpdateOne.mock.calls[0]
		expect(itemUpdateOne).toHaveBeenCalledOnce()
		expect(filter).toEqual({ _id })
		expect(update).toEqual({ $set: { published } })
	})

	// `matchedCount`, not `modifiedCount`: re-publishing something already published matches one document
	// and modifies none, and that is the state the operator asked for.
	it('accepts a flip that changed nothing', async () => {
		itemExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })

		await expect(funItemUpdatePublished(_id, true)).resolves.toBeUndefined()
	})

	it('answers 404 when the id names no item', async () => {
		itemExec.mockResolvedValueOnce({ matchedCount: 0 })

		expect(await rejection(funItemUpdatePublished(_id, false))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'item not found'
		})
	})
})

describe('throwIfParentNotTopLevel', () => {
	// ⚠️ The read is a write, and the `$inc` is the entire reason this is not a `findOne`. MongoDB
	// transactions are snapshot-isolated rather than serialisable, so snapshot isolation permits write
	// skew: read the parent, have `itemCategoryDel` retire it, write the child, and both transactions
	// commit having each seen a consistent snapshot. Touching `__v` puts this transaction on the very
	// document that delete stamps, one of the two is aborted with a `WriteConflict`, and `withTransaction`
	// retries it. `__v` because nothing reads it and the validator already declares it `bsonType: 'int'`.
	// The projection is the other half: this asks one question — does the parent have a parent — and
	// pulling the whole document to answer it would put the name, slug and position on the wire for nothing.
	it('reads the parent with a write, in the caller session, projecting one field', async () => {
		await expect(throwIfParentNotTopLevel(idParent, inSession)).resolves.toBeUndefined()

		expect(itemCategoryFindOneAndUpdate).toHaveBeenCalledExactlyOnceWith(
			{ _id: idParent, deleted: live },
			{ $inc: { __v: 1 } },
			{ projection: { idParent: 1 } }
		)
		expect(threaded).toEqual([session])
	})

	// ⚠️ Compared as strings, and the fixture is two *distinct* ObjectId instances holding one value —
	// which is what the resolver really receives, since the argument is cast from a GraphQLID string
	// while `_id` comes from elsewhere. A `===` here would be false on those two objects and the cycle
	// would be written.
	it('refuses a category named as its own parent, without reading anything', async () => {
		const same = new Types.ObjectId('507f1f77bcf86cd799439030')

		expect(same).not.toBe(idParent)
		expect(await rejection(throwIfParentNotTopLevel(same, inSession, idParent))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'itemCategory.idParent: a category cannot be its own parent'
		})
		expect(itemCategoryFindOneAndUpdate).not.toHaveBeenCalled()
	})

	// The update path passes `_id` on every call, so a document being edited under a *different* parent has to
	// get past the self-check and reach the read.
	it('still reads when the category being edited is not the parent named', async () => {
		await expect(throwIfParentNotTopLevel(idParent, inSession, _id)).resolves.toBeUndefined()

		expect(itemCategoryFindOneAndUpdate).toHaveBeenCalledOnce()
	})

	// 404 and not 400: an id naming nothing is the ordinary stale-client failure. A soft-deleted parent
	// counts as missing — the `deleted` clause above is what makes it so, and a subcategory under an
	// invisible parent is unreachable from `/category/:slug/:subSlug`. It is also the answer the retried
	// transaction lands on when it lost the race to a concurrent delete.
	it('answers 404 when the parent is absent or retired', async () => {
		itemCategoryFindOneAndUpdate.mockReturnValueOnce(finding(null))

		expect(await rejection(throwIfParentNotTopLevel(idParent, inSession))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'parent category not found'
		})
	})

	// ⚠️ The depth cap itself, and this function is its entire enforcement on the platform: no
	// `$jsonSchema` can read a second document to ask whether the parent has a parent.
	it('answers 400 when the parent is itself a subcategory', async () => {
		itemCategoryFindOneAndUpdate.mockReturnValueOnce(finding({ _id: idParent, idParent: _id }))

		expect(await rejection(throwIfParentNotTopLevel(idParent, inSession))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'itemCategory.idParent: the taxonomy is two levels deep — a subcategory cannot have children'
		})
	})
})

describe('throwIfHasChildren', () => {
	// Retired children do not count, which is what the `deleted` clause buys: refusing over a subcategory
	// somebody withdrew a year ago would make the parent permanently unmovable.
	//
	// No `$inc` of its own, and that is not an oversight: the racing `itemCategoryAdd` writes the parent it
	// files under, while the update this count guards writes that same document. The two collide there.
	it('counts live subcategories in the caller session', async () => {
		await expect(throwIfHasChildren(_id, inSession)).resolves.toBeUndefined()

		expect(itemCategoryCountDocuments).toHaveBeenCalledExactlyOnceWith({ idParent: _id, deleted: live })
		expect(threaded).toEqual([session])
	})

	// The downwards half of the cap. Without it, handing a parent to a category that already has three
	// subcategories pushes all three to the third level without a single write naming them.
	it('answers 400 when the category still has subcategories', async () => {
		itemCategoryCountDocuments.mockReturnValueOnce(counting(1))

		expect(await rejection(throwIfHasChildren(_id, inSession))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'itemCategory.idParent: this category has subcategories — move or remove them first'
		})
	})
})

describe('funItemCategoryAdd', () => {
	// No parent, no read: a top-level category is the ordinary case and asking the database about an
	// `idParent` nobody sent would be one round trip per create for nothing.
	it('creates a top-level category with a fresh _id, reading no parent', async () => {
		await expect(funItemCategoryAdd(data)).resolves.toBeUndefined()

		const [[doc], options] = itemCategoryCreate.mock.calls[0]
		expect(itemCategoryFindOneAndUpdate).not.toHaveBeenCalled()
		expect(doc).toMatchObject(data)
		// Minted here rather than by mongoose: every model in marketplace-common declares `_id` without a
		// default, which switches auto-generation off and makes `create()` throw on a document without one.
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
		// ⚠️ The array form because it is the only one that carries options, and the session has to be one of
		// them: a create outside the session commits on its own and outlives an abort of the transaction that
		// checked the parent.
		expect(options).toEqual({ session })
	})

	it('checks the parent before writing a subcategory', async () => {
		await expect(funItemCategoryAdd({ ...(data as object), idParent } as never)).resolves.toBeUndefined()

		expect(itemCategoryFindOneAndUpdate).toHaveBeenCalledOnce()
		expect(itemCategoryCreate).toHaveBeenCalledOnce()
	})

	// ⚠️ Inside the transaction, not before it. A parent checked outside is a parent checked against a
	// snapshot the create never shares, which is the window this whole change exists to close.
	it('checks the parent inside the transaction', async () => {
		withTransaction.mockImplementationOnce(async (work) => {
			expect(itemCategoryFindOneAndUpdate).not.toHaveBeenCalled()

			await work()
		})

		await expect(funItemCategoryAdd({ ...(data as object), idParent } as never)).resolves.toBeUndefined()

		expect(itemCategoryFindOneAndUpdate).toHaveBeenCalledOnce()
	})

	// ⚠️ The `_id` is minted once, outside the callback, and a retry is exactly what the `$inc` provokes:
	// the loser of a `WriteConflict` is re-run by `withTransaction`. A retry that re-mints would create a
	// second document for one request the moment two operators file subcategories under one parent.
	it('re-uses one _id when the transaction is retried', async () => {
		withTransaction.mockImplementationOnce(async (work) => {
			await work()
			await work()
		})

		await expect(funItemCategoryAdd(data)).resolves.toBeUndefined()

		const ids = itemCategoryCreate.mock.calls.map(([[doc]]) => String(doc._id))
		expect(ids).toHaveLength(2)
		expect(ids[0]).toBe(ids[1])
	})

	it('does not write when the parent is a subcategory', async () => {
		itemCategoryFindOneAndUpdate.mockReturnValueOnce(finding({ _id: idParent, idParent: _id }))

		await expect(funItemCategoryAdd({ ...(data as object), idParent } as never)).rejects.toThrow('Bad Request')
		expect(itemCategoryCreate).not.toHaveBeenCalled()
	})

	// `slug` is the collection's only unique index and it is unique **across both levels**, since
	// `/category/:slug` and `/category/:slug/:subSlug` share one namespace of first segments. A 409 named
	// after the field, not the 500 `tryCatchRethrow` would otherwise report to Sentry. Caught outside
	// `withTransaction`: a duplicate key carries no transient label, so it aborts and arrives here untouched.
	it('turns a duplicate slug into a 409 naming the field', async () => {
		itemCategoryCreate.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }))

		expect(await rejection(funItemCategoryAdd(data))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'slug already used by another category'
		})
	})

	// Anything else is left exactly as it came, for `tryCatchRethrow` in the resolver to turn into a 500
	// and report — swallowing it here would hide a broken database behind a validation message.
	it('rethrows any other driver failure untouched', async () => {
		const driverError = new Error('connection reset')
		itemCategoryCreate.mockRejectedValueOnce(driverError)

		await expect(funItemCategoryAdd(data)).rejects.toBe(driverError)
	})
})

describe('funItemCategoryDelete', () => {
	// ⚠️ Refused while anything live still points at it, which is *not* how `companyDel` behaves on this
	// same tier. `item.idCategory` is required, so retiring a stocked category leaves items filed under
	// a category no read path returns — resolvable items, a filter that does not exist, and nothing
	// anywhere saying so.
	it('stamps deleted once nothing live points at it, counting and writing in one session', async () => {
		await expect(funItemCategoryDelete(_id)).resolves.toBeUndefined()

		expect(itemCategoryCountDocuments).toHaveBeenCalledExactlyOnceWith({ idParent: _id, deleted: live })
		expect(itemCountDocuments).toHaveBeenCalledExactlyOnceWith({ idCategory: _id, deleted: live })
		// Both counts and the stamp: three queries, one session. A count taken outside it reads a snapshot
		// the stamp does not share, and the subcategory it missed survives under a retired parent.
		expect(threaded).toEqual([session, session, session])

		const [filter, update] = itemCategoryUpdateOne.mock.calls[0]
		expect(filter).toEqual({ _id })
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		expect(typeof update.$set.deleted).toBe('number')
	})

	// Children first, and the item count is not even asked for: the second read costs a full collection
	// scan of `idCategory` on a category nobody can delete anyway.
	it('refuses a category with subcategories, before counting items', async () => {
		itemCategoryCountDocuments.mockReturnValueOnce(counting(1))

		expect(await rejection(funItemCategoryDelete(_id))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'the category still has subcategories'
		})
		expect(itemCountDocuments).not.toHaveBeenCalled()
		expect(itemCategoryUpdateOne).not.toHaveBeenCalled()
	})

	// The alternative — cascade — was rejected on purpose: one Delete would silently withdraw an unbounded
	// number of other shop owners' items. Re-filing them is the operator's call to make explicitly.
	it('refuses a category that still holds items, without writing', async () => {
		itemCountDocuments.mockReturnValueOnce(counting(1))

		expect(await rejection(funItemCategoryDelete(_id))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'the category still holds items'
		})
		expect(itemCategoryUpdateOne).not.toHaveBeenCalled()
	})

	it('answers 404 when the id names no category', async () => {
		categoryExec.mockResolvedValueOnce({ matchedCount: 0 })

		expect(await rejection(funItemCategoryDelete(_id))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'category not found'
		})
	})
})

describe('funItemCategoryUpdate', () => {
	// ⚠️ `$unset`, not `$set: { idParent: null }`: the collection declares `bsonType: 'objectId'` under
	// `additionalProperties: false`, so a null fails the write outright and "no parent" is spelled by the
	// field not being there. Promoting a subcategory back to the top level is exactly this write.
	it('clears the parent when none was sent, and checks nothing', async () => {
		await expect(funItemCategoryUpdate(_id, data)).resolves.toBeUndefined()

		expect(itemCategoryFindOneAndUpdate).not.toHaveBeenCalled()
		expect(itemCategoryCountDocuments).not.toHaveBeenCalled()
		expect(itemCategoryUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			{ $set: { name: 'Footwear', slug: 'footwear', position: 0 }, $unset: { idParent: 1 } }
		)
		// ⚠️ The key set, separately: `toEqual` ignores a property holding `undefined`, so a `$set` built
		// as `{ ...rest, idParent }` with nothing to put there passes the assertion above while writing
		// `idParent: null` through the driver — which `bsonType: 'objectId'` refuses, taking the save
		// with it.
		expect(Object.keys(itemCategoryUpdateOne.mock.calls[0][1].$set)).toEqual(['name', 'slug', 'position'])
	})

	// Both halves of the cap on the one path that needs both — upwards at the parent, downwards at this
	// document's own children — and the empty `$unset` is what keeps `$set` and `$unset` from ever naming the
	// same path, which the driver refuses with a conflict.
	it('writes the parent after checking upwards then downwards, all in one session', async () => {
		await expect(funItemCategoryUpdate(_id, { ...(data as object), idParent } as never)).resolves.toBeUndefined()

		expect(itemCategoryFindOneAndUpdate).toHaveBeenCalledOnce()
		expect(itemCategoryCountDocuments).toHaveBeenCalledExactlyOnceWith({ idParent: _id, deleted: live })
		expect(threaded).toEqual([session, session, session])
		expect(itemCategoryUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			{ $set: { name: 'Footwear', slug: 'footwear', position: 0, idParent }, $unset: {} }
		)
	})

	// ⚠️ Both guards inside the transaction, like the create path: a parent that read as top-level outside
	// it can be given a parent of its own before this update lands, and the third level appears without a
	// single write naming it.
	it('runs both checks inside the transaction', async () => {
		withTransaction.mockImplementationOnce(async (work) => {
			expect(itemCategoryFindOneAndUpdate).not.toHaveBeenCalled()
			expect(itemCategoryCountDocuments).not.toHaveBeenCalled()

			await work()
		})

		await expect(funItemCategoryUpdate(_id, { ...(data as object), idParent } as never)).resolves.toBeUndefined()

		expect(itemCategoryFindOneAndUpdate).toHaveBeenCalledOnce()
		expect(itemCategoryCountDocuments).toHaveBeenCalledOnce()
	})

	it('does not look downwards, or write, when the parent is not top-level', async () => {
		itemCategoryFindOneAndUpdate.mockReturnValueOnce(finding({ _id: idParent, idParent: _id }))

		await expect(funItemCategoryUpdate(_id, { ...(data as object), idParent } as never)).rejects.toThrow('Bad Request')
		expect(itemCategoryCountDocuments).not.toHaveBeenCalled()
		expect(itemCategoryUpdateOne).not.toHaveBeenCalled()
	})

	it('does not write when the category being filed has subcategories of its own', async () => {
		itemCategoryCountDocuments.mockReturnValueOnce(counting(1))

		await expect(funItemCategoryUpdate(_id, { ...(data as object), idParent } as never)).rejects.toThrow('Bad Request')
		expect(itemCategoryUpdateOne).not.toHaveBeenCalled()
	})

	it('turns a duplicate slug into a 409 naming the field', async () => {
		itemCategoryUpdateOne.mockImplementationOnce(() => {
			throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
		})

		expect(await rejection(funItemCategoryUpdate(_id, data))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'slug already used by another category'
		})
	})

	it('rethrows any other driver failure untouched', async () => {
		const driverError = new Error('connection reset')
		categoryExec.mockRejectedValueOnce(driverError)

		await expect(funItemCategoryUpdate(_id, data)).rejects.toBe(driverError)
	})

	// `matchedCount`, not `modifiedCount`: saving a category unchanged matched one document and modified
	// none, and reading the other counter would 404 on every no-op save.
	it('accepts a save that changed nothing, and answers 404 when nothing matched', async () => {
		categoryExec.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 })
		await expect(funItemCategoryUpdate(_id, data)).resolves.toBeUndefined()

		categoryExec.mockResolvedValueOnce({ matchedCount: 0 })
		expect(await rejection(funItemCategoryUpdate(_id, data))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'category not found'
		})
	})
})

/*
 * ⚠️ The three category write paths are transactions and the two item paths are not, and the split is
 * deliberate rather than partial work. Each category path is a read that decides whether a write is legal
 * followed by that write, on two different documents; the item paths are single writes, which are atomic
 * on their own and would gain nothing but a session.
 *
 * `withTransaction` rather than a hand-rolled `startTransaction`/`commitTransaction` pair because it is
 * the form that retries a `TransientTransactionError` — which is exactly what the `$inc` in
 * `throwIfParentNotTopLevel` provokes when two operators race. Without the retry the loser would answer a
 * `WriteConflict` to a request with nothing wrong with it.
 */
describe('every itemCategory write path is one transaction that ends its session', () => {
	const boom = new Error('connection reset')

	const paths = [
		['funItemCategoryAdd', () => funItemCategoryAdd(data), () => itemCategoryCreate.mockRejectedValueOnce(boom)],
		['funItemCategoryUpdate', () => funItemCategoryUpdate(_id, data), () => categoryExec.mockRejectedValueOnce(boom)],
		['funItemCategoryDelete', () => funItemCategoryDelete(_id), () => categoryExec.mockRejectedValueOnce(boom)]
	] as const

	it.each(paths)('%s opens one session and does its work inside it', async (_label, run) => {
		await expect(run()).resolves.toBeUndefined()

		expect(startSession).toHaveBeenCalledOnce()
		expect(withTransaction).toHaveBeenCalledOnce()
		expect(endSession).toHaveBeenCalledOnce()
	})

	// The `finally`, proved on its own: a session left open on the failure path holds a server-side slot
	// until the server times it out, and every one of these paths can fail — a dead connection, a duplicate
	// slug, a guard refusing.
	it.each(paths)('%s ends the session when the work throws', async (_label, run, fail) => {
		fail()

		await expect(run()).rejects.toBe(boom)
		expect(endSession).toHaveBeenCalledOnce()
	})
})
