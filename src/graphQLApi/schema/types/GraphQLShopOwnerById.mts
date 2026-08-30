import { GraphQLShopOwnerAddress } from '@ptypes/GraphQLShopOwnerAddress.mjs'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

export const GraphQLShopOwnerById = new GraphQLObjectType({
	name: 'GraphQLShopOwnerById',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		login: { type: new GraphQLNonNull(GraphQLShopOwnerLogin) },
		/**
		 * ⚠️ **Nullable, for the reason the table's is.** `shopOwner.personalData` stopped being required
		 * when `shopOwnerRegister` shipped, and this is the page an admin opens to decide whether to
		 * approve exactly those accounts: under a `NonNull` the query for a pending registration returned
		 * an error instead of a document, so the one account that needed looking at was the one that
		 * could not be looked at. `login.email` and `registeredAt` are what the page has to work with
		 * until onboarding fills the rest in.
		 */
		personalData: { type: GraphQLShopOwnerPersonalDataById },
		registeredAt: { type: new GraphQLNonNull(GraphQLDateTime) },
		deleted: { type: GraphQLDateTime },
		disabled: { type: GraphQLBoolean },
		/**
		 * Who suspended this account and why (ADR-044). Both are absent on an account that is not
		 * suspended: `funShopOwnerUpdateStatus` `$unset`s the trio together, so the three are read on
		 * presence and never on `false`.
		 *
		 * ⚠️ **This is the only surface where the reason is legible at all.** `disabledReason` is randomly
		 * encrypted (ADR-029), so an admin reading the collection with a shell sees `binData`; the
		 * driver decrypts it here because this service holds the data key. Dropping it from the type would
		 * not hide the field, it would make a suspension unanswerable.
		 *
		 * `disabledBy` is an attribution and not a foreign key — ADR-044 says so — so it is a bare `ID` a
		 * screen prints. Nothing joins on it, and an `admin` that no longer exists leaves it dangling by
		 * design.
		 */
		disabledBy: { type: GraphQLID },
		disabledReason: { type: GraphQLString },
		waitApprov: { type: GraphQLBoolean },
		// Admin-only, and safe to expose here precisely because this is the admin tier: the
		// ShopOwner-tier services never load this model at all, so the note has no way of reaching
		// the person it was written about.
		notes: { type: GraphQLString },
		resetPwd: { type: GraphQLResetPwd }
	})
})

const GraphQLShopOwnerLogin = new GraphQLObjectType({
	name: 'GraphQLShopOwnerLogin',
	fields: () => ({
		email: { type: new GraphQLNonNull(GraphQLString) },
		firstLogin: { type: GraphQLDateTime },
		lastLogin: { type: GraphQLDateTime },
		onboardingStep: { type: GraphQLString },
		onboardingDone: { type: GraphQLBoolean },
		rememberMe: { type: GraphQLBoolean }
	})
})

const GraphQLShopOwnerPersonalDataById = new GraphQLObjectType({
	name: 'GraphQLShopOwnerPersonalDataById',
	fields: () => ({
		firstName: { type: new GraphQLNonNull(GraphQLString) },
		lastName: { type: new GraphQLNonNull(GraphQLString) },
		address: { type: new GraphQLNonNull(GraphQLShopOwnerAddress) },
		birth: { type: new GraphQLNonNull(GraphQLBirth) },
		contacts: { type: new GraphQLNonNull(GraphQLShopOwnerContacts) }
	})
})

const GraphQLShopOwnerContacts = new GraphQLObjectType({
	name: 'GraphQLShopOwnerContacts',
	fields: () => ({
		email: { type: new GraphQLNonNull(GraphQLString) },
		landline: { type: GraphQLString },
		mobile: { type: new GraphQLNonNull(GraphQLString) }
	})
})
const GraphQLResetPwd = new GraphQLObjectType({
	name: 'GraphQLResetPwd',
	fields: () => ({
		resetDateReq: { type: new GraphQLNonNull(GraphQLDateTime) },
		resetHash: { type: new GraphQLNonNull(GraphQLString) }
	})
})

const GraphQLBirth = new GraphQLObjectType({
	name: 'GraphQLBirth',
	fields: () => ({
		date: { type: new GraphQLNonNull(GraphQLDateTime) }
	})
})
