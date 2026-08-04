import { GraphQLIndirizzoBaseFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLIndirizzoBaseFrag'
import { GraphQLPositionFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * A company, as its own entity.
 *
 * These fields were `puntoVendita.azienda`, an embedded object, until 20260803000100 lifted them into
 * the `azienda` collection — which is why a chain's three pizzerias no longer store the ragione sociale
 * three times, and why the unique partita IVA no longer refuses the second of them.
 *
 * `idImprenditore` is exposed rather than kept internal: the operator app reaches a company through its
 * owner's detail page and the field is what a client re-reading one row can check it against.
 *
 * `cf` and `univoco` are the two nullable fields, matching the collection's `required` array. Neither
 * is a gap to be filled in later — no stored company carries a `cf`, since the field did not exist
 * before the extraction.
 */
export const GraphQLAzienda = new GraphQLObjectType({
	name: 'GraphQLAzienda',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idImprenditore: { type: new GraphQLNonNull(GraphQLID) },
		ragionesociale: { type: new GraphQLNonNull(GraphQLString) },
		piva: { type: new GraphQLNonNull(GraphQLString) },
		cf: { type: GraphQLString },
		referente: { type: new GraphQLNonNull(GraphQLString) },
		amministratore: { type: new GraphQLNonNull(GraphQLString) },
		univoco: { type: GraphQLString },
		pec: { type: new GraphQLNonNull(GraphQLString) },
		indirizzo: { type: new GraphQLNonNull(GraphQLAziendaIndirizzo) },
		// The path of the uploaded visura, not the document. Required, and capped at 1000 characters by
		// the collection — it was the one unbounded string on the embedded shape.
		visura: { type: new GraphQLNonNull(GraphQLString) }
	})
})

/**
 * The company's legal seat — not the address of any of its shops.
 *
 * Its own type rather than `GraphQLPVIndirizzo` reused, on the same grounds every other duplicated
 * declaration on this tier stands on: a GraphQL type name is global to the schema, and tying the shape
 * of two collections' addresses to one name means a field added for one of them silently appears on the
 * other. What *is* shared is the field map — both spread the same fragments from marketplace-common, which
 * is the platform's answer to keeping the four address fields identical.
 */
const GraphQLAziendaIndirizzo = new GraphQLObjectType({
	name: 'GraphQLAziendaIndirizzo',
	fields: () => ({
		...GraphQLIndirizzoBaseFrag,
		position: { type: new GraphQLNonNull(GraphQLAziendaPosition) }
	})
})

const GraphQLAziendaPosition = new GraphQLObjectType({
	name: 'GraphQLAziendaPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
