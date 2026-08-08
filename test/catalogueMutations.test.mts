import { GraphQLError } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const funItemDelete = vi.fn()
const funItemUpdatePublished = vi.fn()
const funItemCategoryAdd = vi.fn()
const funItemCategoryDelete = vi.fn()
const funItemCategoryUpdate = vi.fn()
const captureException = vi.fn()

vi.mock('@lib/item/funItemDelete.mjs', () => ({ funItemDelete }))
vi.mock('@lib/item/funItemUpdatePublished.mjs', () => ({ funItemUpdatePublished }))
vi.mock('@lib/itemCategory/funItemCategoryAdd.mjs', () => ({ funItemCategoryAdd }))
vi.mock('@lib/itemCategory/funItemCategoryDelete.mjs', () => ({ funItemCategoryDelete }))
vi.mock('@lib/itemCategory/funItemCategoryUpdate.mjs', () => ({ funItemCategoryUpdate }))
// tryCatchRethrow and `@lib/validate/*` are NOT mocked, the same decision `mutations.test.mts` makes:
// what these resolvers are for is that a bad field never reaches the lib and a driver failure arrives
// as the right status. A stub asserts neither. Only Sentry is stopped from firing.
vi.mock('@sentry/node', () => ({ captureException }))

const { itemCategoryAdd } = await import('../src/graphQLApi/schema/mutations/itemCategoryAdd.mts')
const { itemCategoryDel } = await import('../src/graphQLApi/schema/mutations/itemCategoryDel.mts')
const { itemCategoryUpdate } = await import('../src/graphQLApi/schema/mutations/itemCategoryUpdate.mts')
const { itemDel } = await import('../src/graphQLApi/schema/mutations/itemDel.mts')
const { itemUpdatePublished } = await import('../src/graphQLApi/schema/mutations/itemUpdatePublished.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439020')
const idParent = new Types.ObjectId('507f1f77bcf86cd799439030')

/** As the operator's form sends it — untrimmed, because the validator is real here. */
const itemCategory = { name: ' Footwear ', slug: ' footwear ', idParent, position: 3 }

/** The same category once `validateItemCategory` is done with it. */
const validated = { name: 'Footwear', slug: 'footwear', idParent, position: 3 }

type Resolver = { resolve: (...a: never[]) => unknown }

const run = (mutation: Resolver, args: unknown) => mutation.resolve(null as never, args as never)

/** Anything not a duplicate key ends up a 500 through `tryCatchRethrow`, reported to Sentry. */
const driverError = new Error('connection reset')

beforeEach(() => {
	vi.clearAllMocks()
	funItemDelete.mockResolvedValue(undefined)
	funItemUpdatePublished.mockResolvedValue(undefined)
	funItemCategoryAdd.mockResolvedValue(undefined)
	funItemCategoryDelete.mockResolvedValue(undefined)
	funItemCategoryUpdate.mockResolvedValue(undefined)
})

describe('itemCategoryAdd', () => {
	// The validator runs here rather than in the lib, so the lib is handed a normalised row and never a
	// padded one — a slug written with the operator's stray spaces is a public URL nobody can reach.
	it('validates, then creates, and answers true', async () => {
		await expect(run(itemCategoryAdd, { itemCategory })).resolves.toBe(true)

		expect(funItemCategoryAdd).toHaveBeenCalledExactlyOnceWith(validated)
	})

	// `Boolean!` and not the new id, like every other write on this tier: the category screen re-reads
	// `itemCategories` after a save and has no use for one.
	it('does not write when a field is refused, and does not report it to Sentry', async () => {
		expect(await rejection(run(itemCategoryAdd, { itemCategory: { ...itemCategory, slug: 'Footwear' } }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'itemCategory.slug: lowercase letters, digits and single hyphens only'
		})
		expect(funItemCategoryAdd).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	// A 409 raised by the lib keeps its status instead of being flattened to a 500 — the whole reason the
	// catch goes through `tryCatchRethrow` rather than rethrowing blindly.
	it('keeps a duplicate-slug conflict as a 409', async () => {
		funItemCategoryAdd.mockRejectedValueOnce(
			new GraphQLError('Conflict', {
				extensions: { http: { status: 409 }, description: 'slug already used by another category' }
			})
		)

		expect(await rejection(run(itemCategoryAdd, { itemCategory }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'slug already used by another category'
		})
		expect(captureException).not.toHaveBeenCalled()
	})
})

describe('itemCategoryUpdate', () => {
	// ⚠️ The input is the object `itemCategoryAdd` takes, so an omitted `idParent` means "top-level
	// category" and not "leave the parent alone" — this is a save of the row, not a patch. It is what
	// makes promoting a subcategory back to the top level expressible at all.
	it('validates, then saves the row whole under its id', async () => {
		await expect(run(itemCategoryUpdate, { _id, itemCategory })).resolves.toBe(true)

		expect(funItemCategoryUpdate).toHaveBeenCalledExactlyOnceWith(_id, validated)
	})

	it('does not write when a field is refused', async () => {
		expect(await rejection(run(itemCategoryUpdate, { _id, itemCategory: { ...itemCategory, position: 1.5 } }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'itemCategory.position: whole number required'
		})
		expect(funItemCategoryUpdate).not.toHaveBeenCalled()
	})
})

describe('itemCategoryDel', () => {
	it('delegates the retirement and answers true', async () => {
		await expect(run(itemCategoryDel, { _id })).resolves.toBe(true)

		expect(funItemCategoryDelete).toHaveBeenCalledExactlyOnceWith(_id)
	})

	// The one delete on this tier that can be turned down for a reason other than "no such row", and the
	// reason has to survive the catch: 400 with the text, not a 500 naming nothing.
	it('keeps the refusal when the category still holds items', async () => {
		funItemCategoryDelete.mockRejectedValueOnce(
			new GraphQLError('Bad Request', { extensions: { http: { status: 400 }, description: 'the category still holds items' } })
		)

		expect(await rejection(run(itemCategoryDel, { _id }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'the category still holds items'
		})
		expect(captureException).not.toHaveBeenCalled()
	})
})

describe('itemDel', () => {
	it('delegates the withdrawal and answers true', async () => {
		await expect(run(itemDel, { _id })).resolves.toBe(true)

		expect(funItemDelete).toHaveBeenCalledExactlyOnceWith(_id)
	})
})

describe('itemUpdatePublished', () => {
	// No `validate*` call, unlike every other write here: `Boolean!` is the whole contract, so GraphQL has
	// already refused everything a validator would have. Both values are passed through untouched.
	it.each([
		['unpublishes', false],
		['publishes', true]
	])('%s an item, passing the flag straight through', async (_label, published) => {
		await expect(run(itemUpdatePublished, { _id, published })).resolves.toBe(true)

		expect(funItemUpdatePublished).toHaveBeenCalledExactlyOnceWith(_id, published)
	})
})

// One table rather than five copies of the same test: every resolver here has the identical catch, and
// what matters is that none of them swallows a broken database into a `true`.
describe('a driver failure', () => {
	it.each([
		['itemCategoryAdd', () => run(itemCategoryAdd, { itemCategory }), funItemCategoryAdd],
		['itemCategoryUpdate', () => run(itemCategoryUpdate, { _id, itemCategory }), funItemCategoryUpdate],
		['itemCategoryDel', () => run(itemCategoryDel, { _id }), funItemCategoryDelete],
		['itemDel', () => run(itemDel, { _id }), funItemDelete],
		['itemUpdatePublished', () => run(itemUpdatePublished, { _id, published: true }), funItemUpdatePublished]
	])('reaches the client as a 500 from %s, and Sentry as itself', async (_name, call, fun) => {
		fun.mockRejectedValueOnce(driverError)

		expect(await rejection(call())).toMatchObject({ message: 'Internal Server Error', http: { status: 500 } })
		expect(captureException).toHaveBeenCalledExactlyOnceWith(driverError)
	})
})
