import { GraphQLBaseAddressFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

/** The shape the row resolver reads. Only the members this type reaches into are declared. */
export interface IShopOwnerActiveTblRow {
	login: { email: string }
}

export const GraphQLShopOwnerActiveTbl = new GraphQLObjectType({
	name: 'GraphQLShopOwnerActiveTbl',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		registeredAt: { type: new GraphQLNonNull(GraphQLDateTime) },
		/**
		 * The address the account authenticates with, and on a self-registered row the only thing that
		 * identifies it: `personalData` below is absent until onboarding, so a queue row would otherwise
		 * be a date and an id. Admin tier only — `shopOwnerById` already answers the same field to the
		 * same audience.
		 *
		 * Flattened out of `login` by hand. The document nests it, the table renders one column, and the
		 * alternative — a `login` object with a single member — would put a level of nesting in every
		 * query for a field that has no siblings worth exposing here.
		 */
		email: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (row: IShopOwnerActiveTblRow) => row.login.email
		},
		/**
		 * ⚠️ **Nullable, and it must stay nullable.** `shopOwner.personalData` stopped being required when
		 * `shopOwnerRegister` shipped: a stranger signing themselves up gives an address and a password,
		 * and nothing else exists until onboarding. Under the `NonNull` this field used to carry, one
		 * pending registration made the *whole page* an error — `items` is a non-null list of non-null
		 * rows, so a null anywhere in it propagates all the way up — and the table an admin needs in
		 * order to approve that very account was the table it broke.
		 */
		personalData: { type: GraphQLPersonalData },
		/**
		 * Present and true while the account waits for an admin. Written by `shopOwnerRegister` (a
		 * stranger signed themselves up) and by `shopOwnerUpdateStatus` (an admin parked an existing
		 * account), `$unset` on approval — so the approved state is an absent key, never `false`, and the
		 * frontend renders "pending" on truthiness rather than on equality.
		 *
		 * `shopOwnerAdd` writes nothing here on purpose: an account an admin created by hand has been
		 * approved by the act of creating it.
		 */
		waitApprov: { type: GraphQLBoolean },
		/**
		 * Nullable, and not merely permissive: the flag is stored `true` or removed outright, so an
		 * enabled account has no `disabled` key and reads as absent rather than `false` — the same shape
		 * `waitApprov` above has, and the same shape the customer row carries.
		 */
		disabled: { type: GraphQLBoolean },
		/**
		 * Who suspended this account and why (ADR-044). Absent together on an account that is not
		 * suspended — `funShopOwnerUpdateStatus` `$unset`s the trio as one — so both are read on presence.
		 *
		 * ⚠️ **Legible here and on `shopOwnerById`, nowhere else.** `disabledReason` is randomly encrypted
		 * (ADR-029); this service holds the data key, so the driver hands back the text, while a shell or
		 * a shop-owner service reading the same document sees `binData`.
		 *
		 * `disabledBy` is an attribution rather than a foreign key (ADR-044): nothing joins on it, and an
		 * `admin` that no longer exists leaves it dangling by design.
		 */
		disabledBy: { type: GraphQLID },
		disabledReason: { type: GraphQLString },
		/**
		 * A timestamp, not a flag (ADR-011). Written by `shopOwnerDel` on this service, which also
		 * withdraws the storefront (ADR-045). The stamp is permanent — nothing on this platform removes a
		 * document (ADR-041) — and the row carries it so the table can say "Closed" rather than say
		 * nothing and list the account under a filter that claims it is trading.
		 */
		deleted: { type: GraphQLDateTime }
	})
})

const GraphQLPersonalData = new GraphQLObjectType({
	name: 'GraphQLPersonalData',
	fields: () => ({
		firstName: { type: new GraphQLNonNull(GraphQLString) },
		lastName: { type: new GraphQLNonNull(GraphQLString) },
		address: { type: new GraphQLNonNull(GraphQLShopOwnerAddressTbl) }
	})
})

const GraphQLShopOwnerAddressTbl = new GraphQLObjectType({
	name: 'GraphQLShopOwnerAddressTbl',
	fields: () => ({
		...GraphQLBaseAddressFrag
	})
})
