import { GraphQLBaseAddressFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLPositionFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * A company, as its own entity.
 *
 * These fields lived on a per-shop embedded object — a shop IS a `company`; there is no shop collection
 * and will not be one — until 20260803000100 lifted them into the `company` collection itself, which is
 * why a shopOwner running three shops no longer stores the registered legal name three times, and why the
 * unique VAT number no longer refuses the second of them.
 *
 * `idShopOwner` is exposed rather than kept internal: the operator app reaches a company through its
 * owner's detail page and the field is what a client re-reading one company can check it against.
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
		registryExtract: { type: new GraphQLNonNull(GraphQLString) },
		// The shop listing, added 2026-08-04 with the catalogue. A company IS the shop here — there is no
		// shop collection and will not be one — so the storefront's heading, URL and body text have nowhere
		// else to live.
		//
		// `publicName` is the trading name over the door, and is not `legalName`: a registered legal name
		// carries the legal form ("… Ltd") and is the wrong string on a customer-facing card.
		//
		// The three are nullable because the collection made them optional — `collMod` cannot re-validate
		// documents already stored, and no slug can be derived from a registered legal name without inventing one. What
		// keeps them from being permanently blank is the collection's `$expr`: `published: true` is refused
		// unless `slug` and `publicName` are both strings.
		publicName: { type: GraphQLString },
		slug: { type: GraphQLString },
		description: { type: GraphQLString },
		// The only one of the four that is `required` in the collection, and so NonNull here: the three-step
		// widen → backfill → narrow the migration paid for means every stored document has it.
		published: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})

/**
 * The company's legal seat — not the address of any of its shops.
 *
 * Its own type rather than `GraphQLShopOwnerAddress` reused, on the same grounds every other duplicated
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
