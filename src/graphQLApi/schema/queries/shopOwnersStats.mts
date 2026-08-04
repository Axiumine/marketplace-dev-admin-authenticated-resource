import shopOwnersStatsDb from '@lib/shopOwner/shopOwnersStatsDb.mjs'
import { GraphQLInt, GraphQLNonNull } from 'graphql'

export const shopOwnersStats = {
	description: 'ShopOwners stats',
	type: new GraphQLNonNull(GraphQLInt),
	async resolve() {
		return await shopOwnersStatsDb()
	}
}
