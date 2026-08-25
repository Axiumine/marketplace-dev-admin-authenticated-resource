import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

/** The shape the two row resolvers read. Only the members this type reaches into are declared. */
export interface IUserActiveTblRow {
	login: { email: string }
	emailVerify?: { valid?: boolean }
}

/**
 * One row of the operator's customers table.
 *
 * ⚠️ **No name, no address, no `personalData` of any kind, by design.** The shop-owner row carries all
 * three because `shopOwner` leaves them in the clear for exactly that table; `user` was designed not to
 * pay that bill (ADR-029), and this epic's point is a table that does not incur it. What is here is the
 * identity the support request arrives with and the three flags that say what the account can do.
 */
export const GraphQLUserActiveTbl = new GraphQLObjectType({
	name: 'GraphQLUserActiveTbl',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		registeredAt: { type: new GraphQLNonNull(GraphQLDateTime) },
		/**
		 * The address the account authenticates with, and the only thing on this row that identifies a
		 * person. Deterministically encrypted, so the driver hands it back as plaintext and an equality
		 * lookup on it works — which is what makes "find the account for this address" possible without a
		 * search argument this table cannot have.
		 *
		 * Flattened out of `login` by hand, as on the shop-owner row: the document nests it, the table
		 * renders one column, and a `login` object with a single member would be a level of nesting in
		 * every query for a field with no siblings worth exposing here.
		 */
		email: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (row: IUserActiveTblRow) => row.login.email
		},
		/**
		 * Nullable, and not merely permissive: the flag is stored `true` or removed outright, so an enabled
		 * account has no `disabled` key and reads as absent rather than `false`. The frontend renders the
		 * state on truthiness, the way it does `waitApprov` on the shop-owner table.
		 */
		disabled: { type: GraphQLBoolean },
		/**
		 * A timestamp, not a flag (ADR-011) — and today always absent, because **nothing anywhere writes
		 * it**: there is no `userDel` on any tier and a customer cannot close their own account either
		 * (E19.md §6, question 3). It is on the row because the filter can ask for it and because the day
		 * an erasure path lands, the operator table must not be the last screen to know.
		 */
		deleted: { type: GraphQLDateTime },
		/**
		 * Whether the customer confirmed the address above — the one gate between registering and logging
		 * in on this tier, since `user` has no `waitApprov` and never will (E07.md §6).
		 *
		 * Flattened, and nullable for the same reason `disabled` is: `enableEmailAccess` is what writes
		 * `valid`, so an account that has not confirmed yet has no `emailVerify.valid` key rather than a
		 * `false` one.
		 */
		emailVerified: {
			type: GraphQLBoolean,
			resolve: (row: IUserActiveTblRow) => row.emailVerify?.valid
		}
	})
})
