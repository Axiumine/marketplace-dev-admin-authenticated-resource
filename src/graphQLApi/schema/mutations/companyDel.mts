import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funCompanyDelete } from '@lib/company/funCompanyDelete.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Deletes one company.
 *
 * A soft delete: the lib stamps `deleted` and every read path filters on its absence, so the company
 * disappears from the operator's page without the document going anywhere. It answers `Boolean!` all
 * the same — the client re-reads the list after a save.
 */
export const companyDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'deletes a company',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funCompanyDelete(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
