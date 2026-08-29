import { GraphQLEnumType } from 'graphql'

// Reported, never requested. The bucket width follows from the range — see the RANGES table in
// `@lib/stats/registeredAtSeriesDb.mjs` — and the client needs to be told which one it got so it can
// label the axis by month or by day. A client that could ask for it would be able to ask for day
// buckets over the whole life of the platform.
//
// ⚠️ **Collection-neutral, and in its own file since 2026-08-29 for that reason.** Both charts report
// it — `GraphQLShopOwnersPerPeriod` and `GraphQLUsersPerPeriod` — and a shared type reached through
// the shopOwners file would read as a shopOwners type that customers borrow. It is neither: it names
// the two bucket widths the series library offers, which is a property of the library.
export const GraphQLPeriodGranularity = new GraphQLEnumType({
	name: 'GraphQLPeriodGranularity',
	description: 'Width of the series buckets',
	values: {
		DAY: { description: 'One point per day' },
		MONTH: { description: 'One point per month' }
	}
})
