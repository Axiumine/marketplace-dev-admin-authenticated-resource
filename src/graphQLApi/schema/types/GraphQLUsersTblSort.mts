import { GraphQLEnumType } from 'graphql'

// Value-less like `GraphQLShopOwnersTblSortField`: with no `value` key, graphql-js defaults each enum
// value's internal representation to its own NAME, so the resolver receives the string 'REGISTERED_AT'
// and never a Mongo path. Mapping that name onto `registeredAt` is application logic and lives in
// `@lib/user/usersActiveTblDb.mjs`, where the mutation gate reaches it — everything under
// `schema/types/` is excluded from Stryker's `mutate` list, so a wrong path hard-coded here would never
// be challenged by a surviving-mutant report.
//
// ⚠️ **One member, and it stays one member.** `sortBy` becomes a key of the Mongo sort
// document, and on `user` the only clear field worth ordering by is the registration date: the names and
// the city are randomly encrypted (ADR-029), so a `LAST_NAME` added here would sort the customer base by
// ciphertext — an order that is stable, arbitrary and looks exactly like a working sort. It is an enum
// rather than a dropped argument so the client shape matches the shop-owner table and a second sortable
// *clear* field could be added without a breaking change, not because one is planned.
//
// `GraphQLSortDirection` is not redeclared here: it is one type in one schema, and it lives in
// `GraphQLShopOwnersTblSort.mts` because that table needed it first.
export const GraphQLUsersTblSortField = new GraphQLEnumType({
	name: 'GraphQLUsersTblSortField',
	description: 'Sort column of the users table',
	values: {
		REGISTERED_AT: { description: 'Registration date' }
	}
})
