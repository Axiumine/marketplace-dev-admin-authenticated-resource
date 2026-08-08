import { GraphQLEnumType } from 'graphql'

// Deliberately value-less: with no `value` key, graphql-js defaults each enum value's internal
// representation to its own NAME, so the resolver receives the string 'REGISTERED_AT', not a Mongo
// path. Mapping those names onto `registeredAt` / `personalData.lastName` / … is application logic and
// lives in `@lib/shopOwner/shopOwnersActiveTblDb.mjs`, where the mutation gate reaches it —
// everything under `schema/types/` is excluded from Stryker's `mutate` list, so a wrong path
// hard-coded here would never be challenged by a surviving-mutant report.
//
// The enum is also what keeps the sort safe. `sortBy` reaches MongoDB as a key of the sort
// document; accepting a free String there would let a caller order by any field in the collection,
// including ones no index covers, and turn a cheap query into a full blocking sort on demand. Only
// these four are offered, and each one has a matching index (see the shopOwner tbl migration in
// marketplace-db-setup).
export const GraphQLShopOwnersTblSortField = new GraphQLEnumType({
	name: 'GraphQLShopOwnersTblSortField',
	description: 'Sort column of the shopOwners table',
	values: {
		REGISTERED_AT: { description: 'Registration date' },
		FIRST_NAME: { description: 'FirstName' },
		LAST_NAME: { description: 'LastName, then firstName' },
		CITY: { description: 'City of residence' }
	}
})

export const GraphQLSortDirection = new GraphQLEnumType({
	name: 'GraphQLSortDirection',
	description: 'Sort direction',
	values: {
		ASC: { description: 'Ascending' },
		DESC: { description: 'Descending' }
	}
})
