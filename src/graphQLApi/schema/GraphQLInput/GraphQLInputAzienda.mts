import { GraphQLIndirizzoFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLIndirizzoFrag'
import { GraphQLFloat, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * The company's legal seat, as the operator's form sends it.
 *
 * Coordinates only, no `type`: the GeoJSON type has one legal value, the collection caps the field at 5
 * characters and the model declares it as an enum of `['Point']`, so an input field for it could only
 * ever carry the right answer or a document that fails validation naming a field the operator never
 * saw. `validaIndirizzo` writes the literal.
 */
const GraphQLInputAziendaPosition = new GraphQLInputObjectType({
	name: 'GraphQLInputAziendaPosition',
	fields: () => ({
		coordinates: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLFloat))) }
	})
})

const GraphQLInputAziendaIndirizzo = new GraphQLInputObjectType({
	name: 'GraphQLInputAziendaIndirizzo',
	fields: () => ({
		...GraphQLIndirizzoFrag,
		position: { type: new GraphQLNonNull(GraphQLInputAziendaPosition) }
	})
})

/**
 * Everything an operator types about a company, in one object.
 *
 * One argument rather than nine, because it is one form and one Save — `aziendaAdd` and `aziendaUpdate`
 * both take it whole, which is also what lets the update path `$set` the document in a single atomic
 * write.
 *
 * `_id` and `idImprenditore` are **not** here. The first is minted by the lib; the second is a separate
 * argument on `aziendaAdd` and is absent from `aziendaUpdate` altogether, so a company cannot be moved
 * to another owner by editing its card.
 *
 * Nullability mirrors the collection's `required` array — `cf` and `univoco` are the two optional ones.
 */
export const GraphQLInputAzienda = new GraphQLInputObjectType({
	name: 'GraphQLInputAzienda',
	fields: () => ({
		ragionesociale: { type: new GraphQLNonNull(GraphQLString) },
		piva: { type: new GraphQLNonNull(GraphQLString) },
		cf: { type: GraphQLString },
		referente: { type: new GraphQLNonNull(GraphQLString) },
		amministratore: { type: new GraphQLNonNull(GraphQLString) },
		univoco: { type: GraphQLString },
		pec: { type: new GraphQLNonNull(GraphQLString) },
		indirizzo: { type: new GraphQLNonNull(GraphQLInputAziendaIndirizzo) },
		visura: { type: new GraphQLNonNull(GraphQLString) }
	})
})
