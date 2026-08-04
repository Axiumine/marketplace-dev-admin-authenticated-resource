import shopOwnersPerPeriodDb, { ShopOwnersPeriod } from '@lib/shopOwner/shopOwnersPerPeriodDb.mjs'
import { GraphQLShopOwnersPerPeriod } from '@ptypes/GraphQLShopOwnersPerPeriod.mjs'
import { GraphQLShopOwnersPeriod } from '@ptypes/GraphQLShopOwnersPeriod.mjs'
import { GraphQLNonNull } from 'graphql'

export const shopOwnersPerPeriod = {
	description: 'Time series of registered shopOwners',
	type: new GraphQLNonNull(GraphQLShopOwnersPerPeriod),
	// NonNull + defaultValue, as on `shopOwnersActiveTbl`: the caller may omit it, but the resolver
	// is never handed an explicit `null` it would have to re-default. `TUTTO` is the default because
	// it is the only range that answers "how did we get here" without the caller knowing the shape of
	// the data first.
	args: {
		period: { type: new GraphQLNonNull(GraphQLShopOwnersPeriod), defaultValue: 'TUTTO' }
	},
	async resolve(_: unknown, args: { period: ShopOwnersPeriod }) {
		return await shopOwnersPerPeriodDb(args.period)
	}
}
