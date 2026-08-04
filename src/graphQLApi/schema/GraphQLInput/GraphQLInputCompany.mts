import { GraphQLAddressFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLAddressFrag'
import { GraphQLFloat, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * The company's legal seat, as the operator's form sends it.
 *
 * Coordinates only, no `type`: the GeoJSON type has one legal value, the collection caps the field at 5
 * characters and the model declares it as an enum of `['Point']`, so an input field for it could only
 * ever carry the right answer or a document that fails validation naming a field the operator never
 * saw. `validateAddress` writes the literal.
 */
const GraphQLInputCompanyPosition = new GraphQLInputObjectType({
	name: 'GraphQLInputCompanyPosition',
	fields: () => ({
		coordinates: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLFloat))) }
	})
})

const GraphQLInputCompanyAddress = new GraphQLInputObjectType({
	name: 'GraphQLInputCompanyAddress',
	fields: () => ({
		...GraphQLAddressFrag,
		position: { type: new GraphQLNonNull(GraphQLInputCompanyPosition) }
	})
})

/**
 * Everything an operator types about a company, in one object.
 *
 * One argument rather than nine, because it is one form and one Save — `companyAdd` and `companyUpdate`
 * both take it whole, which is also what lets the update path `$set` the document in a single atomic
 * write.
 *
 * `_id` and `idShopOwner` are **not** here. The first is minted by the lib; the second is a separate
 * argument on `companyAdd` and is absent from `companyUpdate` altogether, so a company cannot be moved
 * to another owner by editing its card.
 *
 * Nullability mirrors the collection's `required` array — `taxCode` and `uniqueCode` are the two optional ones.
 */
export const GraphQLInputCompany = new GraphQLInputObjectType({
	name: 'GraphQLInputCompany',
	fields: () => ({
		legalName: { type: new GraphQLNonNull(GraphQLString) },
		vatNumber: { type: new GraphQLNonNull(GraphQLString) },
		taxCode: { type: GraphQLString },
		contactPerson: { type: new GraphQLNonNull(GraphQLString) },
		administrator: { type: new GraphQLNonNull(GraphQLString) },
		uniqueCode: { type: GraphQLString },
		certifiedEmail: { type: new GraphQLNonNull(GraphQLString) },
		address: { type: new GraphQLNonNull(GraphQLInputCompanyAddress) },
		registryExtract: { type: new GraphQLNonNull(GraphQLString) }
	})
})
