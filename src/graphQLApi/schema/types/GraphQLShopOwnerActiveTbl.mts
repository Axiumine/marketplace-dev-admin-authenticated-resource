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
		 * be a date and an id. Operator tier only — `shopOwnerById` already answers the same field to the
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
		 * rows, so a null anywhere in it propagates all the way up — and the table an operator needs in
		 * order to approve that very account was the table it broke.
		 */
		personalData: { type: GraphQLPersonalData },
		/**
		 * Present and true while the account waits for an operator. Written by `shopOwnerRegister` (a
		 * stranger signed themselves up) and by `shopOwnerUpdateStatus` (an operator parked an existing
		 * account), `$unset` on approval — so the approved state is an absent key, never `false`, and the
		 * frontend renders "pending" on truthiness rather than on equality.
		 *
		 * `shopOwnerAdd` writes nothing here on purpose: an account an operator created by hand has been
		 * approved by the act of creating it.
		 */
		waitApprov: { type: GraphQLBoolean }
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
