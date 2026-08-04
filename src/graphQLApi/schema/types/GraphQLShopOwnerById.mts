import { GraphQLShopOwnerAddress } from '@ptypes/GraphQLShopOwnerAddress.mjs'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

export const GraphQLShopOwnerById = new GraphQLObjectType({
	name: 'GraphQLShopOwnerById',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		login: { type: new GraphQLNonNull(GraphQLShopOwnerLogin) },
		personalData: { type: new GraphQLNonNull(GraphQLShopOwnerPersonalDataById) },
		registeredAt: { type: new GraphQLNonNull(GraphQLDateTime) },
		deleted: { type: GraphQLDateTime },
		disabled: { type: GraphQLBoolean },
		waitApprov: { type: GraphQLBoolean },
		// Operator-only, and safe to expose here precisely because this is the operator tier: the
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
