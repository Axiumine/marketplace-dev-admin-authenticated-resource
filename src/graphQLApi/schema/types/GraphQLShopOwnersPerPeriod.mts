import { GraphQLPeriodGranularity } from '@ptypes/GraphQLShopOwnersPeriod.mjs'
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

// One bucket. `date` is a `YYYY-MM-DD` string in both granularities — a month bucket carries its own
// first day — so the client has one parse path and reads `granularity` to decide how to label it.
// String rather than a date scalar because the platform has none, and because the value is already
// a bucket KEY: it is not a moment in time, it is the name of an interval.
export const GraphQLShopOwnersPerPeriodPoint = new GraphQLObjectType({
	name: 'GraphQLShopOwnersPerPeriodPoint',
	fields: () => ({
		date: { type: new GraphQLNonNull(GraphQLString) },
		total: { type: new GraphQLNonNull(GraphQLInt) }
	})
})

// The series, plus the bucket width it was built at. `granularity` is a field rather than something
// the client infers from the points, because inferring it means guessing from spacing — and a range
// in which every month happens to hold one registration is indistinguishable from a daily series
// with a lot of gaps.
export const GraphQLShopOwnersPerPeriod = new GraphQLObjectType({
	name: 'GraphQLShopOwnersPerPeriod',
	fields: () => ({
		granularity: { type: new GraphQLNonNull(GraphQLPeriodGranularity) },
		points: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLShopOwnersPerPeriodPoint))) }
	})
})
