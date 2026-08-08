import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { IItemCategorySchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IItemCategorySchema'
import { requiredSlug, requiredText } from '@lib/validate/fields.mjs'
import { Types } from 'mongoose'

/*
 * From marketplace-db-setup/lib/schemas/itemCategory.js, via 20260804000000-create-itemCategory.js.
 *
 * `slug` is longer than `name` on purpose and both bounds are the collection's: a slug is derived from
 * a name and hyphens make it grow, so a 100-character name that survives `requiredText` must still fit
 * `maxLength: 120` afterwards.
 */
const MAX_NAME = 100
const MAX_SLUG = 120

/** What the `GraphQLInputItemCategory` argument carries: the stored document minus the fields nobody sends. */
export type IItemCategoryInput = Omit<IItemCategorySchema, '_id' | 'deleted' | '__v'>

/** The same fields, normalised and ready to be written whole. */
export type IItemCategoryValidated = IItemCategoryInput

/**
 * A category, every field of it.
 *
 * `position` is checked here rather than left to the collection because `bsonType: 'int'` rejects a
 * fractional number with `Document failed validation` and nothing else — Apollo turns that into a 500
 * naming no field, which is the exact failure this whole validation layer exists to stop. `minimum: 0`
 * is the collection's; a negative ordinal sorts before everything and means nothing.
 *
 * `idParent` is passed through untouched. Whether it names a category that exists, is live, and is itself
 * top-level cannot be answered here — all three take a database read — so they are the resolver's job,
 * in `throwIfParentNotTopLevel`. What this does guarantee is that a category cannot be its own parent
 * *shape*: nothing here invents an `idParent` that was not sent.
 */
export const validateItemCategory = (itemCategory: IItemCategoryInput): IItemCategoryValidated => {
	if (!Number.isInteger(itemCategory.position)) {
		throwErrorWrongUserInput('itemCategory.position: whole number required')
	}

	if (itemCategory.position < 0) throwErrorWrongUserInput('itemCategory.position: cannot be negative')

	return {
		name: requiredText(itemCategory.name, 'itemCategory.name', MAX_NAME),
		slug: requiredSlug(itemCategory.slug, 'itemCategory.slug', MAX_SLUG),
		...(itemCategory.idParent === undefined || itemCategory.idParent === null
			? {}
			: { idParent: itemCategory.idParent as Types.ObjectId }),
		position: itemCategory.position
	}
}
