import { GraphQLEnumType } from 'graphql'

// Deliberately value-less, like GraphQLShopOwnersTblSortField: with no `value` key graphql-js
// defaults each enum value's internal representation to its own NAME, so the resolver receives the
// string 'THREE_MONTHS'. Turning that into a range start and a bucket width is application logic and
// lives in `@lib/stats/registeredAtSeriesDb.mjs`, where the mutation gate reaches it —
// everything under `schema/types/` is excluded from Stryker's `mutate` list, so a wrong number of
// months hard-coded here would never be challenged by a surviving-mutant report.
//
// An enum rather than a day count: the three ranges are the three the chart offers, and a free Int
// would let a caller ask for a hundred years of day buckets — one group per day, gap-filled into an
// array the browser then has to draw.
export const GraphQLShopOwnersPeriod = new GraphQLEnumType({
	name: 'GraphQLShopOwnersPeriod',
	description: 'Time range of the shopOwners chart',
	values: {
		ALL: { description: 'From the first registered shopOwner to today' },
		THREE_MONTHS: { description: 'The last three months' },
		ONE_MONTH: { description: 'The last month' }
	}
})
