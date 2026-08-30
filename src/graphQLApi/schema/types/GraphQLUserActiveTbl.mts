import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

/** The shape the two row resolvers read. Only the members this type reaches into are declared. */
export interface IUserActiveTblRow {
	login: { email: string }
	emailVerify?: { valid?: boolean }
}

/**
 * One row of the admin's customers table.
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
		 * Who suspended this account and why (ADR-044). Absent together on an account that is not
		 * suspended — `funUserUpdateStatus` `$unset`s the trio as one — so both are read on presence.
		 *
		 * ⚠️ **This row is the only place the reason is legible.** `disabledReason` is randomly encrypted
		 * (ADR-029) and the driver decrypts it here because this service holds the data key; a shell
		 * reading the collection sees `binData`. The customers table is the admin's only customer
		 * surface — there is no detail page — so a reason left off this row is a reason nobody can read.
		 *
		 * `disabledBy` is an attribution rather than a foreign key (ADR-044): nothing joins on it, and an
		 * `admin` that no longer exists leaves it dangling by design.
		 */
		disabledBy: { type: GraphQLID },
		disabledReason: { type: GraphQLString },
		/**
		 * A timestamp, not a flag (ADR-011). Written by `userDel` on the customer tier since 2026-08-26 —
		 * a customer closing their own account — and by nothing else: there is still no Admin counterpart
		 * to `shopOwnerDel` (E19.md §6, question 3). The stamp is permanent, because nothing on this
		 * platform removes a document any more (ADR-041); what ends is the personal data, overwritten in
		 * place by the retention sweeper thirty days later, unless the same address registers again inside
		 * that window and takes the account back (ADR-046).
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
