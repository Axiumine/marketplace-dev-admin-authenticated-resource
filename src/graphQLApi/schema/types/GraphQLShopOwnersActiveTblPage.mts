import { GraphQLShopOwnerActiveTbl } from '@ptypes/GraphQLShopOwnerActiveTbl.mjs'
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql'

// One page of the operator table. `total` is the size of the FILTERED set, not of the collection —
// it is what the client needs to render "page 3 of 12", and it changes with `search`. The unfiltered
// headline count is a different question and already has its own query (`shopOwnersStats`).
export const GraphQLShopOwnersActiveTblPage = new GraphQLObjectType({
	name: 'GraphQLShopOwnersActiveTblPage',
	fields: () => ({
		items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLShopOwnerActiveTbl))) },
		total: { type: new GraphQLNonNull(GraphQLInt) }
	})
})
