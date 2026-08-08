import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funItemDelete } from '@lib/item/funItemDelete.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Removes one item, whoever owns it.
 *
 * The heavier half of moderation — `itemUpdatePublished` hides an item and the owner can undo it, this
 * one retires the item. Soft delete, so the `{ idCompany, slug }` unique index stays occupied.
 */
export const itemDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'deletes an item',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funItemDelete(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
