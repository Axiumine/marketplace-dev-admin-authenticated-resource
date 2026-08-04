import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputCompany } from '@GraphQLInput/GraphQLInputCompany.mjs'
import { funCompanyUpdate } from '@lib/company/funCompanyUpdate.mjs'
import { ICompanyInput, validateCompany } from '@lib/validate/validateCompany.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	company: ICompanyInput
}

/**
 * Rewrites one company's data.
 *
 * Same input object as `companyAdd`, minus the owner: `idShopOwner` is not an argument here and is not
 * in `GraphQLInputCompany` either, so editing a card cannot move the company to another shopOwner.
 * That is not an omission to be filled in later — a company's shops are the owner's, and reassigning it
 * would silently hand them over with it.
 *
 * The whole object in one `$set`, for the reason the shop mutations give: it is one form and one Save, on
 * a single document, so the write is atomic and a rejected certified email cannot leave the new ragione sociale
 * already stored.
 */
export const companyUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates a company',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		company: { type: new GraphQLNonNull(GraphQLInputCompany) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funCompanyUpdate(args._id, validateCompany(args.company))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
