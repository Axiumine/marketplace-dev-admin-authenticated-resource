import { GraphQLItemCategoryFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLItemCategoryFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * A category of the platform-wide taxonomy — the one thing in the catalogue only an operator writes.
 *
 * `idParent` is nullable, and that nullability *is* the tree: absent means a top-level category,
 * present means a subcategory of the row it names. Depth is capped at two, which is why the list can
 * come back flat and be assembled client-side without recursing.
 *
 * ⚠️ The cap is enforced in `itemCategoryAdd` and `itemCategoryUpdate` on this tier and **nowhere
 * else**. A MongoDB validator sees one document at a time and the parent's own `idParent` lives in
 * another, so the collection cannot state the rule. If a third write path is ever added, it inherits
 * the obligation.
 */
export const GraphQLItemCategory = new GraphQLObjectType({
	name: 'GraphQLItemCategory',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idParent: { type: GraphQLID },
		...GraphQLItemCategoryFrag
	})
})
