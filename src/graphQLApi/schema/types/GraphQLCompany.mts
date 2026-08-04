import { GraphQLBaseAddressFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLPositionFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * A company, as its own entity.
 *
 * These fields were `puntoVendita.company`, an embedded object, until 20260803000100 lifted them into
 * the `company` collection — which is why a chain's three pizzerias no longer store the ragione sociale
 * three times, and why the unique partita IVA no longer refuses the second of them.
 *
 * `idShopOwner` is exposed rather than kept internal: the operator app reaches a company through its
 * owner's detail page and the field is what a client re-reading one row can check it against.
 *
 * `taxCode` and `uniqueCode` are the two nullable fields, matching the collection's `required` array. Neither
 * is a gap to be filled in later — no stored company carries a `taxCode`, since the field did not exist
 * before the extraction.
 */
export const GraphQLCompany = new GraphQLObjectType({
	name: 'GraphQLCompany',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idShopOwner: { type: new GraphQLNonNull(GraphQLID) },
		legalName: { type: new GraphQLNonNull(GraphQLString) },
		vatNumber: { type: new GraphQLNonNull(GraphQLString) },
		taxCode: { type: GraphQLString },
		contactPerson: { type: new GraphQLNonNull(GraphQLString) },
		administrator: { type: new GraphQLNonNull(GraphQLString) },
		uniqueCode: { type: GraphQLString },
		certifiedEmail: { type: new GraphQLNonNull(GraphQLString) },
		address: { type: new GraphQLNonNull(GraphQLCompanyAddress) },
		// The path of the uploaded registryExtract, not the document. Required, and capped at 1000 characters by
		// the collection — it was the one unbounded string on the embedded shape.
		registryExtract: { type: new GraphQLNonNull(GraphQLString) }
	})
})

/**
 * The company's legal seat — not the address of any of its shops.
 *
 * Its own type rather than `GraphQLPVAddress` reused, on the same grounds every other duplicated
 * declaration on this tier stands on: a GraphQL type name is global to the schema, and tying the shape
 * of two collections' addresses to one name means a field added for one of them silently appears on the
 * other. What *is* shared is the field map — both spread the same fragments from marketplace-common, which
 * is the platform's answer to keeping the four address fields identical.
 */
const GraphQLCompanyAddress = new GraphQLObjectType({
	name: 'GraphQLCompanyAddress',
	fields: () => ({
		...GraphQLBaseAddressFrag,
		position: { type: new GraphQLNonNull(GraphQLCompanyPosition) }
	})
})

const GraphQLCompanyPosition = new GraphQLObjectType({
	name: 'GraphQLCompanyPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
