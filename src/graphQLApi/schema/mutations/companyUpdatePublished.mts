import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funCompanyUpdatePublished } from '@lib/company/funCompanyUpdatePublished.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	published: boolean
}

/**
 * Takes one shop off the public site, or puts it back.
 *
 * No `validate*` call, unlike `companyAdd` and `companyUpdate`: `Boolean!` is the whole contract, so
 * GraphQL has already rejected everything a validator would have. Same shape as `itemUpdatePublished`.
 *
 * ⚠️ Publishing a shop that has never been given a `slug` and a `publicName` fails in the database, not
 * here — see `funCompanyUpdatePublished`. So the card is saved first and published second, which is why
 * `published` is not a field of `GraphQLInputCompany`.
 */
export const companyUpdatePublished = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'publishes or unpublishes a company',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funCompanyUpdatePublished(args._id, args.published)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
