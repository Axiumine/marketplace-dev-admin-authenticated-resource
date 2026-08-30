import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputItemCategory } from '@GraphQLInput/GraphQLInputItemCategory.mjs'
import { funItemCategoryUpdate } from '@lib/itemCategory/funItemCategoryUpdate.mjs'
import { IItemCategoryInput, validateItemCategory } from '@lib/validate/validateItemCategory.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	itemCategory: IItemCategoryInput
}

/**
 * Saves one category, whole.
 *
 * The input is the same object `itemCategoryAdd` takes, so an omitted `idParent` here means "top-level
 * category" rather than "leave the parent alone" — this is a save of the document, not a patch of it. That
 * is what makes promoting a subcategory back to the top level expressible at all: there is no other
 * value the admin could send to clear a parent.
 *
 * ⚠️ Both halves of the two-level depth cap are enforced in the lib, not here. See
 * `funItemCategoryUpdate` — a category that already has subcategories cannot be given a parent, and
 * that check is the one nothing else on the platform performs.
 */
export const itemCategoryUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates an item category',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		itemCategory: { type: new GraphQLNonNull(GraphQLInputItemCategory) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funItemCategoryUpdate(args._id, validateItemCategory(args.itemCategory))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
