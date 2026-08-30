import shopOwnersActiveTblDb, {
	IShopOwnersActiveTblArgs,
	SHOP_OWNERS_TBL_DEFAULT_LIMIT
} from '@lib/shopOwner/shopOwnersActiveTblDb.mjs'
import { GraphQLShopOwnersActiveTblPage } from '@ptypes/GraphQLShopOwnersActiveTblPage.mjs'
import { GraphQLShopOwnersTblSortField, GraphQLSortDirection } from '@ptypes/GraphQLShopOwnersTblSort.mjs'
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'

export const shopOwnersActiveTbl = {
	type: new GraphQLNonNull(GraphQLShopOwnersActiveTblPage),
	description: 'Get shopOwners for the table',
	// NonNull + defaultValue rather than nullable: the caller may omit any of these, but the resolver
	// is never handed an explicit `null` it would have to re-default. The whole paging contract stays
	// readable from the schema — including, through the enums, the only four columns that sort.
	args: {
		offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
		limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: SHOP_OWNERS_TBL_DEFAULT_LIMIT },
		// ⚠️ **`Boolean!` with a default, never a nullable "either" filter, and the four `tbl_active_*`
		// indexes are why**: every one of them leads with `{deleted, disabled}`, so a page that leaves
		// either unbound loses the index for the sort as well as for the filter and falls back to a
		// blocking in-memory sort on a collection that only grows. Four states, each one an indexed
		// query — the same contract `usersActiveTbl` carries (ADR-049).
		//
		// The defaults answer "what does an admin see on arrival" with the live, enabled accounts,
		// which is what `shopOwnersActiveTbl` names.
		disabled: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
		deleted: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
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
