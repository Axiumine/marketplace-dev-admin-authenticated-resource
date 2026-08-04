import imprenditoriStatsDb from '@lib/imprenditore/imprenditoriStatsDb.mjs'
import { GraphQLInt, GraphQLNonNull } from 'graphql'

export const imprenditoriStats = {
	description: 'Imprenditori stats',
	type: new GraphQLNonNull(GraphQLInt),
	async resolve() {
		return await imprenditoriStatsDb()
	}
}
