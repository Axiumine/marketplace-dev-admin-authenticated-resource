import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funShopOwnerDelete } from '@lib/shopOwner/funShopOwnerDelete.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

export const shopOwnerDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'deletes a shopOwner',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funShopOwnerDelete(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
