import { GraphQLIndirizzoBaseFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLIndirizzoBaseFrag'
import { GraphQLPositionFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLObjectType } from 'graphql'

/**
 * ⚠️ `position` is **nullable here and non-null on the shop** (`GraphQLPVIndirizzo`). Not an
 * oversight: the collection made it optional for the same reason — every imprenditore stored before
 * `20260802000300-alter-imprenditore-position-note` has an address and no coordinates, and there is
 * nothing to derive them from without geocoding. A `GraphQLNonNull` here would turn every one of those
 * accounts into a query that errors instead of a map that is simply not drawn yet.
 */
export const GraphQLIndirizzoImprenditore = new GraphQLObjectType({
	name: 'GraphQLIndirizzoImprenditore',
	fields: () => ({
		...GraphQLIndirizzoBaseFrag,
		position: { type: GraphQLPosizioneImprenditore }
	})
})

const GraphQLPosizioneImprenditore = new GraphQLObjectType({
	name: 'GraphQLPosizioneImprenditore',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
