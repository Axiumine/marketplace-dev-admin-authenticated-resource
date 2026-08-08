import { GraphQLBaseAddressFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLPositionFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLObjectType } from 'graphql'

/**
 * ⚠️ `position` is **nullable here and non-null on the shop** (`GraphQLCompanyAddress`). Not an
 * oversight: the collection made it optional for the same reason — every shopOwner stored before
 * `20260802000300-alter-shopOwner-position-note` has an address and no coordinates, and there is
 * nothing to derive them from without geocoding. A `GraphQLNonNull` here would turn every one of those
 * accounts into a query that errors instead of a map that is simply not drawn yet.
 */
export const GraphQLShopOwnerAddress = new GraphQLObjectType({
	name: 'GraphQLShopOwnerAddress',
	fields: () => ({
		...GraphQLBaseAddressFrag,
		position: { type: GraphQLPositionShopOwner }
	})
})

const GraphQLPositionShopOwner = new GraphQLObjectType({
	name: 'GraphQLPositionShopOwner',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
