import usersStatsDb from '@lib/user/usersStatsDb.mjs'
import { GraphQLInt, GraphQLNonNull } from 'graphql'

export const usersStats = {
	description: 'Users stats',
	type: new GraphQLNonNull(GraphQLInt),
	async resolve() {
		return await usersStatsDb()
	}
}
