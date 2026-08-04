import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

export const GraphQLAdminInfoAfterLogin = new GraphQLObjectType({
	name: 'GraphQLAdminInfoAfterLogin',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		email: { type: new GraphQLNonNull(GraphQLString) }
	})
})
