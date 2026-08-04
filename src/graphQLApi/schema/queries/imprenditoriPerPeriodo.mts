import imprenditoriPerPeriodoDb, { PeriodoImprenditori } from '@lib/imprenditore/imprenditoriPerPeriodoDb.mjs'
import { GraphQLImprenditoriPerPeriodo } from '@ptypes/GraphQLImprenditoriPerPeriodo.mjs'
import { GraphQLPeriodoImprenditori } from '@ptypes/GraphQLPeriodoImprenditori.mjs'
import { GraphQLNonNull } from 'graphql'

export const imprenditoriPerPeriodo = {
	description: 'Serie temporale degli imprenditori iscritti',
	type: new GraphQLNonNull(GraphQLImprenditoriPerPeriodo),
	// NonNull + defaultValue, as on `imprenditoriAttiviTbl`: the caller may omit it, but the resolver
	// is never handed an explicit `null` it would have to re-default. `TUTTO` is the default because
	// it is the only range that answers "how did we get here" without the caller knowing the shape of
	// the data first.
	args: {
		periodo: { type: new GraphQLNonNull(GraphQLPeriodoImprenditori), defaultValue: 'TUTTO' }
	},
	async resolve(_: unknown, args: { periodo: PeriodoImprenditori }) {
		return await imprenditoriPerPeriodoDb(args.periodo)
	}
}
