import { GraphQLBaseAddressFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

export const GraphQLShopOwnerActiveTbl = new GraphQLObjectType({
	name: 'GraphQLShopOwnerActiveTbl',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		registeredAt: { type: new GraphQLNonNull(GraphQLDateTime) },
		personalData: { type: new GraphQLNonNull(GraphQLPersonalData) }
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
