import { GraphQLAzienda } from '@ptypes/GraphQLAzienda.mjs'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { GraphQLID, GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted, Types } from 'mongoose'

interface IArgs {
	idImprenditore: Types.ObjectId
}

/**
 * Every company of one imprenditore, for the Aziende box on the operator's detail page.
 *
 * The `deleted` filter matters here for the same reason it matters on every other list on this tier:
 * a deleted company must leave the box the moment it is removed, not linger until the page reloads.
 */
export const imprenditoreAziende = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAzienda))),
	description: 'Get aziende imprenditore',
	args: {
		idImprenditore: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		return Azienda.find({ idImprenditore: args.idImprenditore, deleted: trusted({ $exists: false }) }).lean()
	}
}
