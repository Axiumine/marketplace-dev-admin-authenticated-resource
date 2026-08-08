import { GraphQLItemFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLItemFrag'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * An item, as the operator reviewing a shop's catalogue sees it.
 *
 * Read-only on this tier bar the two moderation writes: the operator does not author a shop's
 * catalogue — the shop owner does, on 4026 — and the only reasons an operator touches an item are
 * taking unlawful content off the public site and removing it outright. There is deliberately no
 * `GraphQLInputItem` here for that reason.
 *
 * `published` is exposed because it is exactly what moderation acts on, and drafts are visible on this
 * tier: an operator reviewing a report needs to see the row whether or not the owner has it live.
 */
export const GraphQLItem = new GraphQLObjectType({
	name: 'GraphQLItem',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idCompany: { type: new GraphQLNonNull(GraphQLID) },
		idCategory: { type: new GraphQLNonNull(GraphQLID) },
		...GraphQLItemFrag,
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})
