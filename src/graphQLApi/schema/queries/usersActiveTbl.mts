import usersActiveTblDb, { IUsersActiveTblArgs, USERS_TBL_DEFAULT_LIMIT } from '@lib/user/usersActiveTblDb.mjs'
import { GraphQLSortDirection } from '@ptypes/GraphQLShopOwnersTblSort.mjs'
import { GraphQLUsersActiveTblPage } from '@ptypes/GraphQLUsersActiveTblPage.mjs'
import { GraphQLUsersTblSortField } from '@ptypes/GraphQLUsersTblSort.mjs'
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull } from 'graphql'

/**
 * The admin's customers list — the first `user*` operation on this tier (E19-S02).
 *
 * Every argument carries a server-side default, so a client that sends none still gets a bounded page,
 * ordered by the only clear field worth ordering by. Paging, filtering and sorting all live in the lib;
 * this file is the wire contract and a pass-through.
 *
 * ⚠️ **No `search` argument, deliberately, and this is the place it would be added.** Every field a
 * search could match on `user` — the two names, the city, a partial email — is encrypted, randomly for
 * all but the login address (ADR-029), and a prefix match against ciphertext returns nothing without
 * erroring. Making those fields searchable was proposed and declined for exactly that reason; the lib
 * repeats the reasoning where the regex would have to be written.
 *
 * ⚠️ **`disabled` and `deleted` are `Boolean!` with a default rather than nullable filters**, so every
 * page names one state of each and the query stays on `tbl_active_registeredAt`. A third "either" state
 * would leave the index's leading field unbound, which turns the sort into a blocking one on a collection
 * that only grows. `emailVerified` is nullable *because* it is outside that index: it filters what the
 * index already bounded, and it is the flag the admin reads off the row rather than narrows by.
 *
 * The defaults answer "what does an admin see on arrival" with the live accounts, which is what
 * `usersActiveTbl` names — and ADR-049 settles that as the arrival state on both admin tables, an admin
 * reaching a hidden account by naming its state rather than by it being greyed in place.
 */
export const usersActiveTbl = {
	type: new GraphQLNonNull(GraphQLUsersActiveTblPage),
	description: 'Get users for the table',
	args: {
		offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
		limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: USERS_TBL_DEFAULT_LIMIT },
		disabled: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
		deleted: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
		emailVerified: { type: GraphQLBoolean },
		sortBy: { type: new GraphQLNonNull(GraphQLUsersTblSortField), defaultValue: 'REGISTERED_AT' },
		sortDir: { type: new GraphQLNonNull(GraphQLSortDirection), defaultValue: 'DESC' }
	},
	async resolve(_: unknown, args: IUsersActiveTblArgs) {
		return await usersActiveTblDb(args)
	}
}
