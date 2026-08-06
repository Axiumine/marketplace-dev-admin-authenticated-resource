import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputItemCategory } from '@GraphQLInput/GraphQLInputItemCategory.mjs'
import { funItemCategoryAdd } from '@lib/itemCategory/funItemCategoryAdd.mjs'
import { IItemCategoryInput, validateItemCategory } from '@lib/validate/validateItemCategory.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'

interface IArgs {
	itemCategory: IItemCategoryInput
}

/**
 * Creates one category of the platform-wide taxonomy.
 *
 * **Admin-only, and that is the whole design of the taxonomy.** Two shops selling the same kind of
 * thing have to land in the same category or the customer-facing filter means nothing, so there is no
 * `itemCategoryAdd` on the shop-owner tier and no `idShopOwner` on the collection. A shop owner picks
 * from this list; they cannot add to it.
 *
 * `Boolean!` like every other write on this tier: the category screen re-reads `itemCategories` after a
 * save and has no use for the new id.
 */
export const itemCategoryAdd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'adds an item category',
	args: {
		itemCategory: { type: new GraphQLNonNull(GraphQLInputItemCategory) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funItemCategoryAdd(validateItemCategory(args.itemCategory))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
