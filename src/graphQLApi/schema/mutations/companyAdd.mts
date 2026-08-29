import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputCompany } from '@GraphQLInput/GraphQLInputCompany.mjs'
import { funCompanyAdd } from '@lib/company/funCompanyAdd.mjs'
import { ICompanyInput, validateCompany } from '@lib/validate/validateCompany.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	idShopOwner: Types.ObjectId
	company: ICompanyInput
}

/**
 * Creates one company under an shopOwner.
 *
 * The owner is an argument: the session belongs to an admin, so `ctx.state.user._id` names the
 * admin and not the shopOwner whose page is open. The lib checks the id before writing.
 *
 * It answers `Boolean!` like every other write on this tier: the detail page re-reads
 * `shopOwnerCompanies` after a save and has no use for the new id.
 */
export const companyAdd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'adds a company to a shopOwner',
	args: {
		idShopOwner: { type: new GraphQLNonNull(GraphQLID) },
		company: { type: new GraphQLNonNull(GraphQLInputCompany) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funCompanyAdd(args.idShopOwner, validateCompany(args.company))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
