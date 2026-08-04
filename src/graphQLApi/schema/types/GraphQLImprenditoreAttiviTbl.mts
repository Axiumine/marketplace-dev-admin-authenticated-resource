import { GraphQLIndirizzoBaseFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLIndirizzoBaseFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

export const GraphQLImprenditoreAttiviTbl = new GraphQLObjectType({
	name: 'GraphQLImprenditoreAttiviTbl',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		iscrizione: { type: new GraphQLNonNull(GraphQLDateTime) },
		anagrafica: { type: new GraphQLNonNull(GraphQLAnagrafica) }
	})
})

const GraphQLAnagrafica = new GraphQLObjectType({
	name: 'GraphQLAnagrafica',
	fields: () => ({
		nome: { type: new GraphQLNonNull(GraphQLString) },
		cognome: { type: new GraphQLNonNull(GraphQLString) },
		indirizzo: { type: new GraphQLNonNull(GraphQLIndirizzoImprenditoreTbl) }
	})
})

const GraphQLIndirizzoImprenditoreTbl = new GraphQLObjectType({
	name: 'GraphQLIndirizzoImprenditoreTbl',
	fields: () => ({
		...GraphQLIndirizzoBaseFrag
	})
})
