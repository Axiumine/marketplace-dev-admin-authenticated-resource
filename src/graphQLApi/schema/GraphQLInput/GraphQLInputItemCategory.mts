import { GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * Everything an admin types about a category, in one object.
 *
 * One argument rather than four, like `GraphQLInputCompany`, because it is one form and one Save —
 * and because it lets the update path `$set` the document in a single atomic write.
 *
 * `idParent` is the only nullable field and is what the two levels are made of: send nothing for a
 * top-level category, send the id of a top-level category for a subcategory. Sending the id of a
 * *subcategory* is the one thing this input can express and the collection cannot refuse, so the
 * resolver does.
 *
 * `position` is a sort ordinal, not a coordinate — the two senses of the word collide across this
 * codebase and only one of them is GeoJSON. `Int!` rather than optional: the alternative is a listing
 * whose order changes between two reads of the same documents.
 */
export const GraphQLInputItemCategory = new GraphQLInputObjectType({
	name: 'GraphQLInputItemCategory',
	fields: () => ({
		name: { type: new GraphQLNonNull(GraphQLString) },
		slug: { type: new GraphQLNonNull(GraphQLString) },
		idParent: { type: GraphQLID },
		position: { type: new GraphQLNonNull(GraphQLInt) }
	})
})
