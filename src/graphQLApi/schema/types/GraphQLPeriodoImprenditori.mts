import { GraphQLEnumType } from 'graphql'

// Deliberately value-less, like GraphQLImprenditoriTblSortField: with no `value` key graphql-js
// defaults each enum value's internal representation to its own NAME, so the resolver receives the
// string 'TRE_MESI'. Turning that into a range start and a bucket width is application logic and
// lives in `@lib/imprenditore/imprenditoriPerPeriodoDb.mjs`, where the mutation gate reaches it —
// everything under `schema/types/` is excluded from Stryker's `mutate` list, so a wrong number of
// months hard-coded here would never be challenged by a surviving-mutant report.
//
// An enum rather than a day count: the three ranges are the three the chart offers, and a free Int
// would let a caller ask for a hundred years of day buckets — one group per day, gap-filled into an
// array the browser then has to draw.
export const GraphQLPeriodoImprenditori = new GraphQLEnumType({
	name: 'GraphQLPeriodoImprenditori',
	description: 'Intervallo temporale del grafico imprenditori',
	values: {
		TUTTO: { description: 'Dal primo imprenditore iscritto a oggi' },
		TRE_MESI: { description: 'Ultimi tre mesi' },
		UN_MESE: { description: 'Ultimo mese' }
	}
})

// Reported, never requested. The bucket width follows from the range — see the RANGES table in the
// lib — and the client needs to be told which one it got so it can label the axis by month or by
// day. A client that could ask for it would be able to ask for day buckets over the whole life of
// the platform.
export const GraphQLGranularitaPeriodo = new GraphQLEnumType({
	name: 'GraphQLGranularitaPeriodo',
	description: 'Ampiezza dei bucket della serie',
	values: {
		GIORNO: { description: 'Un punto al giorno' },
		MESE: { description: 'Un punto al mese' }
	}
})
