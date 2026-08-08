import shopOwnersPerPeriodDb, { ShopOwnersPeriod } from '@lib/shopOwner/shopOwnersPerPeriodDb.mjs'
import { GraphQLShopOwnersPeriod } from '@ptypes/GraphQLShopOwnersPeriod.mjs'
import { GraphQLShopOwnersPerPeriod } from '@ptypes/GraphQLShopOwnersPerPeriod.mjs'
import { GraphQLNonNull } from 'graphql'

export const shopOwnersPerPeriod = {
	description: 'Time series of registered shopOwners',
	type: new GraphQLNonNull(GraphQLShopOwnersPerPeriod),
	// NonNull + defaultValue, as on `shopOwnersActiveTbl`: the caller may omit it, but the resolver
	// is never handed an explicit `null` it would have to re-default. `ALL` is the default because
	// it is the only range that answers "how did we get here" without the caller knowing the shape of
	// the data first.
	//
	// ⚠️ The value has to be a member of the enum, and nothing but the schema test checks that: an
	// unknown default is not a build error, it makes `defaultValue` serialise to `null` and the whole
	// introspection query fail — a failure that names neither this file nor the argument.
	args: {
		period: { type: new GraphQLNonNull(GraphQLShopOwnersPeriod), defaultValue: 'ALL' }
	},
	async resolve(_: unknown, args: { period: ShopOwnersPeriod }) {
		return await shopOwnersPerPeriodDb(args.period)
	}
}
