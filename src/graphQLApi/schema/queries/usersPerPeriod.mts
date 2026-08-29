import usersPerPeriodDb, { UsersPeriod } from '@lib/user/usersPerPeriodDb.mjs'
import { GraphQLUsersPeriod } from '@ptypes/GraphQLUsersPeriod.mjs'
import { GraphQLUsersPerPeriod } from '@ptypes/GraphQLUsersPerPeriod.mjs'
import { GraphQLNonNull } from 'graphql'

export const usersPerPeriod = {
	description: 'Time series of registered users',
	type: new GraphQLNonNull(GraphQLUsersPerPeriod),
	// NonNull + defaultValue, as on `shopOwnersPerPeriod`: the caller may omit it, but the resolver is
	// never handed an explicit `null` it would have to re-default. `ALL` is the default because it is
	// the only range that answers "how did we get here" without the caller knowing the shape of the
	// data first.
	//
	// ⚠️ The value has to be a member of the enum, and nothing but the schema test checks that: an
	// unknown default is not a build error, it makes `defaultValue` serialise to `null` and the whole
	// introspection query fail — a failure that names neither this file nor the argument.
	args: {
		period: { type: new GraphQLNonNull(GraphQLUsersPeriod), defaultValue: 'ALL' }
	},
	async resolve(_: unknown, args: { period: UsersPeriod }) {
		return await usersPerPeriodDb(args.period)
	}
}
