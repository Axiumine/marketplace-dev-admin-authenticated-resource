import { GraphQLIndirizzoImprenditore } from '@ptypes/GraphQLIndirizzoImprenditore.mjs'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'
import { GraphQLDateTime } from 'graphql-scalars'

export const GraphQLImprenditoreById = new GraphQLObjectType({
	name: 'GraphQLImprenditoreById',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		login: { type: new GraphQLNonNull(GraphQLImprenditoreLogin) },
		anagrafica: { type: new GraphQLNonNull(GraphQLAnagraficaImprenditoreById) },
		iscrizione: { type: new GraphQLNonNull(GraphQLDateTime) },
		deleted: { type: GraphQLDateTime },
		disabled: { type: GraphQLBoolean },
		waitApprov: { type: GraphQLBoolean },
		// Operator-only, and safe to expose here precisely because this is the operator tier: the
		// Imprenditore-tier services never load this model at all, so the note has no way of reaching
		// the person it was written about.
		note: { type: GraphQLString },
		resetPwd: { type: GraphQLResetPwd }
	})
})

const GraphQLImprenditoreLogin = new GraphQLObjectType({
	name: 'GraphQLImprenditoreLogin',
	fields: () => ({
		email: { type: new GraphQLNonNull(GraphQLString) },
		firstLogin: { type: GraphQLDateTime },
		lastLogin: { type: GraphQLDateTime },
		onboardingStep: { type: GraphQLString },
		onboardingDone: { type: GraphQLBoolean },
		rememberMe: { type: GraphQLBoolean }
	})
})

const GraphQLAnagraficaImprenditoreById = new GraphQLObjectType({
	name: 'GraphQLAnagraficaImprenditoreById',
	fields: () => ({
		nome: { type: new GraphQLNonNull(GraphQLString) },
		cognome: { type: new GraphQLNonNull(GraphQLString) },
		indirizzo: { type: new GraphQLNonNull(GraphQLIndirizzoImprenditore) },
		nascita: { type: new GraphQLNonNull(GraphQLDataNascita) },
		contatti: { type: new GraphQLNonNull(GraphQLImprenditoreContatti) }
	})
})

const GraphQLImprenditoreContatti = new GraphQLObjectType({
	name: 'GraphQLImprenditoreContatti',
	fields: () => ({
		email: { type: new GraphQLNonNull(GraphQLString) },
		fisso: { type: GraphQLString },
		cellulare: { type: new GraphQLNonNull(GraphQLString) }
	})
})
const GraphQLResetPwd = new GraphQLObjectType({
	name: 'GraphQLResetPwd',
	fields: () => ({
		resetDateReq: { type: new GraphQLNonNull(GraphQLDateTime) },
		resetHash: { type: new GraphQLNonNull(GraphQLString) }
	})
})

const GraphQLDataNascita = new GraphQLObjectType({
	name: 'GraphQLDataNascita',
	fields: () => ({
		data: { type: new GraphQLNonNull(GraphQLDateTime) }
	})
})
