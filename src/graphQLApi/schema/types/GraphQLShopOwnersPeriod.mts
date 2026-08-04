import { GraphQLEnumType } from 'graphql'

// Deliberately value-less, like GraphQLShopOwnersTblSortField: with no `value` key graphql-js
// defaults each enum value's internal representation to its own NAME, so the resolver receives the
// string 'THREE_MONTHS'. Turning that into a range start and a bucket width is application logic and
// lives in `@lib/shopOwner/shopOwnersPerPeriodDb.mjs`, where the mutation gate reaches it —
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

// Reported, never requested. The bucket width follows from the range — see the RANGES table in the
// lib — and the client needs to be told which one it got so it can label the axis by month or by
// day. A client that could ask for it would be able to ask for day buckets over the whole life of
// the platform.
export const GraphQLPeriodGranularity = new GraphQLEnumType({
	name: 'GraphQLPeriodGranularity',
	description: 'Width of the series buckets',
	values: {
		DAY: { description: 'One point per day' },
		MONTH: { description: 'One point per month' }
	}
})
