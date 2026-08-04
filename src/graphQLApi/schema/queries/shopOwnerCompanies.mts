import { GraphQLCompany } from '@ptypes/GraphQLCompany.mjs'
import { Company } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Company'
import { GraphQLID, GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted, Types } from 'mongoose'

interface IArgs {
	idShopOwner: Types.ObjectId
}

/**
 * Every company of one shopOwner, for the Companies box on the operator's detail page.
 *
 * The `deleted` filter matters here for the same reason it matters on every other list on this tier:
 * a deleted company must leave the box the moment it is removed, not linger until the page reloads.
 */
export const shopOwnerCompanies = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLCompany))),
	description: 'Get the companies of a shopOwner',
	args: {
		idShopOwner: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		return Company.find({ idShopOwner: args.idShopOwner, deleted: trusted({ $exists: false }) }).lean()
	}
}
