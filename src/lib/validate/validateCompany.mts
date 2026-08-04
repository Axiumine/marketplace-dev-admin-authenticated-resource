import {
	requiredEmail,
	SHAPE_VAT_NUMBER,
	SHAPE_UNIQUE_CODE,
	textWithFormat,
	requiredText,
	optionalTextWithFormat,
	optionalTextExactLength
} from '@lib/validate/fields.mjs'
import { IAddressInput, validateAddress } from '@lib/validate/validateAddress.mjs'
import { ICompanySchema } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/ICompanySchema'

/*
 * From marketplace-db-setup/migrations/20260803000000-create-company.js.
 *
 * The bounds are `20260301000200-create-puntoVendita.js`'s embedded `company` sub-document, which is
 * where these fields lived until 20260803000100 lifted them into a collection — with two differences,
 * both deliberate and both in that migration:
 *
 *   - `registryExtract` was unbounded and is capped at 1000. It holds the uploaded file's path, not the
 *     document, and it was the only string on the collection able to absorb an arbitrarily long value.
 *   - `taxCode` is new. Exactly 11 characters, optional, and not unique — a company's codice fiscale usually
 *     equals its partita IVA, which `vatNumber_unique` already covers.
 */
const MAX_LEGAL_NAME = 100
const MAX_CONTACT_PERSON = 50
const MAX_ADMINISTRATOR = 50
const MAX_REGISTRY_EXTRACT = 1000
const TAX_CODE_LENGTH = 11

/** What the `GraphQLInputCompany` argument carries: the stored document minus the fields nobody sends. */
export type ICompanyInput = Omit<ICompanySchema, '_id' | 'idShopOwner' | 'address' | '__v'> & {
	address: IAddressInput
}

/**
 * The same fields, normalised and ready to be written whole.
 *
 * `_id` and `idShopOwner` stay out: the first is minted by `funCompanyAdd`, the second is a separate
 * argument on the create path and is **never** written by the update path — moving a company between
 * owners is not a flow anybody has asked for, and `$set` of this object cannot do it by accident.
 */
export type ICompanyValidated = Omit<ICompanySchema, '_id' | 'idShopOwner' | '__v'>

/**
 * A company, every field of it.
 *
 * `taxCode` and `uniqueCode` are the two optional ones and are dropped from the object entirely when blank
 * rather than written as null: `additionalProperties: false` plus `bsonType: 'string'` means a cleared
 * box sent as `null` — which is what GraphQL serialises it to — fails the whole write.
 *
 * The path prefix is `company.` throughout because the fields arrive inside one input object, which is
 * the argument the operator's form maps onto.
 */
export const validateCompany = (company: ICompanyInput): ICompanyValidated => {
	const taxCode = optionalTextExactLength(company.taxCode, 'company.taxCode', TAX_CODE_LENGTH)
	const uniqueCode = optionalTextWithFormat(
		company.uniqueCode,
		'company.uniqueCode',
		SHAPE_UNIQUE_CODE,
		'the unique code is 7 alphanumeric characters'
	)

	return {
		legalName: requiredText(company.legalName, 'company.legalName', MAX_LEGAL_NAME),
		vatNumber: textWithFormat(company.vatNumber, 'company.vatNumber', SHAPE_VAT_NUMBER, 'the VAT number is 11 digits'),
		...(taxCode === undefined ? {} : { taxCode }),
		contactPerson: requiredText(company.contactPerson, 'company.contactPerson', MAX_CONTACT_PERSON),
		administrator: requiredText(company.administrator, 'company.administrator', MAX_ADMINISTRATOR),
		...(uniqueCode === undefined ? {} : { uniqueCode }),
		certifiedEmail: requiredEmail(company.certifiedEmail, 'company.certifiedEmail'),
		address: validateAddress(company.address, 'company.address'),
		registryExtract: requiredText(company.registryExtract, 'company.registryExtract', MAX_REGISTRY_EXTRACT)
	}
}
