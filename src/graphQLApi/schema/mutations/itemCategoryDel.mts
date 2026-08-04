import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funItemCategoryDelete } from '@lib/itemCategory/funItemCategoryDelete.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Retires one category.
 *
 * Refused while a live subcategory or a live item still points at it — see `funItemCategoryDelete` for
 * why that is a 400 and not a cascade. It is the one delete on this tier that can be turned down for a
 * reason other than "no such row".
 */
export const itemCategoryDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'deletes an item category',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funItemCategoryDelete(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
