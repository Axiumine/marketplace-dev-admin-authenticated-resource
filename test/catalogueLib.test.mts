import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const itemUpdateOne = vi.fn()
const itemCountDocuments = vi.fn()
const itemCategoryCreate = vi.fn()
const itemCategoryFindOne = vi.fn()
const itemCategoryUpdateOne = vi.fn()
const itemCategoryCountDocuments = vi.fn()

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }))
// ⚠️ Neither mock carries `deleteOne`, for the reason `companyLib.test.mts` leaves it off Company:
// every delete on this tier is a stamp, and a regression to a hard removal has to fail here rather
// than against a real database. A call to a method the mock does not have throws.
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({
	Item: { updateOne: itemUpdateOne, countDocuments: itemCountDocuments }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: {
		create: itemCategoryCreate,
		findOne: itemCategoryFindOne,
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

/** `updateOne()` ends `.exec()`; `countDocuments()` and `findOne()` end `.lean()`. */
const counting = (found: number) => ({ lean: vi.fn().mockResolvedValue(found) })
const finding = (doc: unknown) => ({ lean: vi.fn().mockResolvedValue(doc) })

/** A category as `validateItemCategory` hands it over: top-level unless a parent is spread in. */
const data = { name: 'Footwear', slug: 'footwear', position: 0 } as never

/** The absence clause every read on this tier shares, tagged so `sanitizeFilter` leaves it alone. */
const live = trusted({ $exists: false })

beforeEach(() => {
	itemUpdateOne.mockReset().mockReturnValue({ exec: itemExec })
	itemExec.mockReset().mockResolvedValue({ matchedCount: 1 })
	itemCountDocuments.mockReset().mockReturnValue(counting(0))
	itemCategoryCreate.mockReset().mockResolvedValue(undefined)
	itemCategoryFindOne.mockReset().mockReturnValue(finding({ _id: idParent }))
	itemCategoryUpdateOne.mockReset().mockReturnValue({ exec: categoryExec })
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
	// The projection is the point: this asks one question — does the parent have a parent — and pulling
	// the whole document to answer it would put the name, slug and position on the wire for nothing.
	it('passes when the parent exists, is live and is top-level', async () => {
		await expect(throwIfParentNotTopLevel(idParent)).resolves.toBeUndefined()

		expect(itemCategoryFindOne).toHaveBeenCalledExactlyOnceWith({ _id: idParent, deleted: live }, { idParent: 1 })
	})

	// ⚠️ Compared as strings, and the fixture is two *distinct* ObjectId instances holding one value —
	// which is what the resolver really receives, since the argument is cast from a GraphQLID string
	// while `_id` comes from elsewhere. A `===` here would be false on those two objects and the cycle
	// would be written.
	it('refuses a category named as its own parent, without reading anything', async () => {
		const same = new Types.ObjectId('507f1f77bcf86cd799439030')

		expect(same).not.toBe(idParent)
		expect(await rejection(throwIfParentNotTopLevel(same, idParent))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'itemCategory.idParent: a category cannot be its own parent'
		})
		expect(itemCategoryFindOne).not.toHaveBeenCalled()
	})

	// The update path passes `_id` on every call, so a document being edited under a *different* parent has to
	// get past the self-check and reach the read.
	it('still reads when the category being edited is not the parent named', async () => {
		await expect(throwIfParentNotTopLevel(idParent, _id)).resolves.toBeUndefined()

		expect(itemCategoryFindOne).toHaveBeenCalledOnce()
	})

	// 404 and not 400: an id naming nothing is the ordinary stale-client failure. A soft-deleted parent
	// counts as missing — the `deleted` clause above is what makes it so, and a subcategory under an
	// invisible parent is unreachable from `/category/:slug/:subSlug`.
	it('answers 404 when the parent is absent or retired', async () => {
		itemCategoryFindOne.mockReturnValueOnce(finding(null))

		expect(await rejection(throwIfParentNotTopLevel(idParent))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'parent category not found'
		})
	})

	// ⚠️ The depth cap itself, and this function is its entire enforcement on the platform: no
	// `$jsonSchema` can read a second document to ask whether the parent has a parent.
	it('answers 400 when the parent is itself a subcategory', async () => {
		itemCategoryFindOne.mockReturnValueOnce(finding({ _id: idParent, idParent: _id }))

		expect(await rejection(throwIfParentNotTopLevel(idParent))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'itemCategory.idParent: the taxonomy is two levels deep — a subcategory cannot have children'
		})
	})
})

describe('throwIfHasChildren', () => {
	// Retired children do not count, which is what the `deleted` clause buys: refusing over a subcategory
	// somebody withdrew a year ago would make the parent permanently unmovable.
	it('passes for a category with no live subcategory', async () => {
		await expect(throwIfHasChildren(_id)).resolves.toBeUndefined()

		expect(itemCategoryCountDocuments).toHaveBeenCalledExactlyOnceWith({ idParent: _id, deleted: live })
	})

	// The downwards half of the cap. Without it, handing a parent to a category that already has three
	// subcategories pushes all three to the third level without a single write naming them.
	it('answers 400 when the category still has subcategories', async () => {
		itemCategoryCountDocuments.mockReturnValueOnce(counting(1))

		expect(await rejection(throwIfHasChildren(_id))).toEqual({
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

		const [doc] = itemCategoryCreate.mock.calls[0]
		expect(itemCategoryFindOne).not.toHaveBeenCalled()
		expect(doc).toMatchObject(data)
		// Minted here rather than by mongoose: every model in marketplace-common declares `_id` without a
		// default, which switches auto-generation off and makes `create()` throw on a document without one.
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
	})

	it('checks the parent before writing a subcategory', async () => {
		await expect(funItemCategoryAdd({ ...(data as object), idParent } as never)).resolves.toBeUndefined()

		expect(itemCategoryFindOne).toHaveBeenCalledOnce()
		expect(itemCategoryCreate).toHaveBeenCalledOnce()
	})

	it('does not write when the parent is a subcategory', async () => {
		itemCategoryFindOne.mockReturnValueOnce(finding({ _id: idParent, idParent: _id }))

		await expect(funItemCategoryAdd({ ...(data as object), idParent } as never)).rejects.toThrow('Bad Request')
		expect(itemCategoryCreate).not.toHaveBeenCalled()
	})

	// `slug` is the collection's only unique index and it is unique **across both levels**, since
	// `/category/:slug` and `/category/:slug/:subSlug` share one namespace of first segments. A 409 named
	// after the field, not the 500 `tryCatchRethrow` would otherwise report to Sentry.
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
	it('stamps deleted once nothing live points at it', async () => {
		await expect(funItemCategoryDelete(_id)).resolves.toBeUndefined()

		expect(itemCategoryCountDocuments).toHaveBeenCalledExactlyOnceWith({ idParent: _id, deleted: live })
		expect(itemCountDocuments).toHaveBeenCalledExactlyOnceWith({ idCategory: _id, deleted: live })

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

		expect(itemCategoryFindOne).not.toHaveBeenCalled()
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
	it('writes the parent after checking upwards then downwards', async () => {
		await expect(funItemCategoryUpdate(_id, { ...(data as object), idParent } as never)).resolves.toBeUndefined()

		expect(itemCategoryFindOne).toHaveBeenCalledOnce()
		expect(itemCategoryCountDocuments).toHaveBeenCalledExactlyOnceWith({ idParent: _id, deleted: live })
		expect(itemCategoryUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			{ $set: { name: 'Footwear', slug: 'footwear', position: 0, idParent }, $unset: {} }
		)
	})

	it('does not look downwards, or write, when the parent is not top-level', async () => {
		itemCategoryFindOne.mockReturnValueOnce(finding({ _id: idParent, idParent: _id }))

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
