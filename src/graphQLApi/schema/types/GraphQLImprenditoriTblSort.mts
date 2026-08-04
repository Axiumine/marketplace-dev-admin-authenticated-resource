import { GraphQLEnumType } from 'graphql'

// Deliberately value-less: with no `value` key, graphql-js defaults each enum value's internal
// representation to its own NAME, so the resolver receives the string 'ISCRIZIONE', not a Mongo
// path. Mapping those names onto `iscrizione` / `anagrafica.cognome` / … is application logic and
// lives in `@lib/imprenditore/imprenditoriAttiviTblDb.mjs`, where the mutation gate reaches it —
// everything under `schema/types/` is excluded from Stryker's `mutate` list, so a wrong path
// hard-coded here would never be challenged by a surviving-mutant report.
//
// The enum is also what keeps the sort safe. `sortBy` reaches MongoDB as a key of the sort
// document; accepting a free String there would let a caller order by any field in the collection,
// including ones no index covers, and turn a cheap query into a full blocking sort on demand. Only
// these four are offered, and each one has a matching index (see the imprenditore tbl migration in
// marketplace-db-setup).
export const GraphQLImprenditoriTblSortField = new GraphQLEnumType({
	name: 'GraphQLImprenditoriTblSortField',
	description: 'Colonna di ordinamento della tabella imprenditori',
	values: {
		ISCRIZIONE: { description: 'Data di iscrizione' },
		NOME: { description: 'Nome' },
		COGNOME: { description: 'Cognome, poi nome' },
		COMUNE: { description: 'Comune di residenza' }
	}
})

export const GraphQLSortDirection = new GraphQLEnumType({
	name: 'GraphQLSortDirection',
	description: 'Direzione di ordinamento',
	values: {
		ASC: { description: 'Crescente' },
		DESC: { description: 'Decrescente' }
	}
})
