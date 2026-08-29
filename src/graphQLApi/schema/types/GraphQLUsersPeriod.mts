import { GraphQLEnumType } from 'graphql'

// The customers chart's range, and the twin of `GraphQLShopOwnersPeriod` — same three members, same
// value-less spelling, so graphql-js hands the resolver the member NAME and the range arithmetic stays
// in `@lib/stats/registeredAtSeriesDb.mjs` where the mutation gate reaches it.
//
// ⚠️ **A second enum rather than one shared range type, and the two must stay in step by hand.** They
// are separate because the descriptions are: "the first registered shopOwner" and "the first registered
// customer" are different dates on the same platform, and a schema is read by people. `GraphQLPeriodGranularity`
// went the other way and is shared — it names bucket widths, which belong to the library rather than
// to either collection. The schema test asserts both member lists, so a range added to one and not the
// other is caught there.
export const GraphQLUsersPeriod = new GraphQLEnumType({
	name: 'GraphQLUsersPeriod',
	description: 'Time range of the customers chart',
	values: {
		ALL: { description: 'From the first registered customer to today' },
		THREE_MONTHS: { description: 'The last three months' },
		ONE_MONTH: { description: 'The last month' }
	}
})
