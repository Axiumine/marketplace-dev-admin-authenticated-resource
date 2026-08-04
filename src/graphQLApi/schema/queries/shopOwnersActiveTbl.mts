import shopOwnersActiveTblDb, {
	IShopOwnersActiveTblArgs,
	SHOP_OWNERS_TBL_DEFAULT_LIMIT
} from '@lib/shopOwner/shopOwnersActiveTblDb.mjs'
import { GraphQLShopOwnersActiveTblPage } from '@ptypes/GraphQLShopOwnersActiveTblPage.mjs'
import { GraphQLShopOwnersTblSortField, GraphQLSortDirection } from '@ptypes/GraphQLShopOwnersTblSort.mjs'
import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'

export const shopOwnersActiveTbl = {
	type: new GraphQLNonNull(GraphQLShopOwnersActiveTblPage),
	description: 'Get shopOwners for the table',
	// NonNull + defaultValue rather than nullable: the caller may omit any of these, but the resolver
	// is never handed an explicit `null` it would have to re-default. The whole paging contract stays
	// readable from the schema — including, through the enums, the only four columns that sort.
	args: {
		offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
		limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: SHOP_OWNERS_TBL_DEFAULT_LIMIT },
		// The one nullable argument: "not searching" is a real state of the table, and a distinct one
		// from searching for the empty string.
		search: { type: GraphQLString },
		sortBy: { type: new GraphQLNonNull(GraphQLShopOwnersTblSortField), defaultValue: 'REGISTERED_AT' },
		sortDir: { type: new GraphQLNonNull(GraphQLSortDirection), defaultValue: 'DESC' }
	},
	async resolve(_: unknown, args: IShopOwnersActiveTblArgs) {
		return await shopOwnersActiveTblDb(args)
	}
}
