import { GraphQLUserActiveTbl } from '@ptypes/GraphQLUserActiveTbl.mjs'
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql'

// One page of the operator's customers table. `total` is the size of the FILTERED set, not of the
// collection — it is what the client turns into "page 3 of 12", and it moves with the three filter
// arguments. The unfiltered headline count is a different question, and one this tier has not been
// asked (`phase5/epics/E19.md` §6, question 2 — there is no `usersStats`).
export const GraphQLUsersActiveTblPage = new GraphQLObjectType({
	name: 'GraphQLUsersActiveTblPage',
	fields: () => ({
		items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLUserActiveTbl))) },
		total: { type: new GraphQLNonNull(GraphQLInt) }
	})
})
