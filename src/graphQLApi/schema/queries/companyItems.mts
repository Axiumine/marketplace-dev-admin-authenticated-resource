import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { GraphQLItem } from '@ptypes/GraphQLItem.mjs'
import { GraphQLID, GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted, Types } from 'mongoose'

interface IArgs {
	idCompany: Types.ObjectId
}

/**
 * Every item of one company, for the operator's moderation view.
 *
 * The same query the owner runs on 4026, minus the ownership guard — an operator owns nothing, and
 * moderating means looking at somebody else's catalogue. Drafts are included for the same reason they
 * are there: an unpublished item is still reportable, and a moderator who only sees published rows
 * cannot act before the owner publishes.
 */
export const companyItems = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLItem))),
	description: 'Get the items of a company',
	args: {
		idCompany: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		return Item.find({ idCompany: args.idCompany, deleted: trusted({ $exists: false }) }).lean()
	}
}
