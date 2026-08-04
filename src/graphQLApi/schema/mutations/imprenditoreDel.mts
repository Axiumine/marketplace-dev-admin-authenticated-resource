import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funImprenditoreDelete } from '@lib/imprenditore/funImprenditoreDelete.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

export const imprenditoreDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'elimina imprenditore',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funImprenditoreDelete(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
