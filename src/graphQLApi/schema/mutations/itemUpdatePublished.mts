import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funItemUpdatePublished } from '@lib/item/funItemUpdatePublished.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	published: boolean
}

/**
 * Takes one item off the public site, or puts it back.
 *
 * No `validate*` call, unlike every other write here: `Boolean!` is the whole contract, so GraphQL has
 * already rejected everything a validator would have. Same shape as `shopOwnerUpdateStatus`.
 *
 * ⚠️ The owner can undo it from 4026 and nothing records that an operator did it — see
 * `funItemUpdatePublished`.
 */
export const itemUpdatePublished = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'publishes or unpublishes an item',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funItemUpdatePublished(args._id, args.published)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
