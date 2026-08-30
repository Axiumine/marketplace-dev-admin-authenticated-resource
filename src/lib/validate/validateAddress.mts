import { ICompanyAddress } from '@axiumine/marketplace-common/models/MongoDBInterfaces/ICompanySchema'
import { coordinate, requiredText, SHAPE_POSTAL_CODE, SHAPE_PROVINCE, textWithFormat } from '@lib/validate/fields.mjs'

/*
 * The one address validator on this tier, for `company.address`.
 *
 * Until 2026-08-04 this also served the now-gone shop collection's `address` — the two collections
 * stored the same shape, the same bounds and the same tuple-form GeoJSON point, which is why the
 * function was written generic on a `prefix` path rather than hard-coded to one caller. That collection
 * is gone along with every mutation that took an address, so `company` is the only caller left; the
 * generic shape stayed rather than being collapsed into `validateCompany.mts`, since nothing about it
 * is company-specific.
 *
 * ⚠️ `MAX_ADDRESS` is 100 here and 250 on a shopOwner. Same field name, same fragment on the
 * GraphQL side, different collections and different caps — the shopOwner validator lives in
 * validateShopOwnerPersonalData.mts and must stay there.
 */
const MAX_ADDRESS = 100
const MAX_CITY = 100

/** The only value `position.type` may hold — the Mongoose model declares it as an enum of one. */
const POSITION_TYPE = 'Point'

/**
 * What an address input carries: the four address fields, and a position that is coordinates only.
 *
 * `position.type` is deliberately absent — see `validateAddress`: this service owns its own input type,
 * shaped so there is no way to get the GeoJSON type wrong.
 */
export type IAddressInput = Omit<ICompanyAddress, 'position'> & { position: { coordinates: number[] } }

/**
 * An address, including its GeoJSON point.
 *
 * `prefix` is the path the fields hang off in the mutation that called — `company.address`, since
 * the address arrives inside the `company` input object. The admin reads that path in the error
 * message, so it has to name the box they are actually looking at. The parameter stayed generic rather
 * than hard-coded to that one literal on the same reasoning the module doc-comment gives.
 *
 * `position.type` is **written**, not read off the argument. There is exactly one legal value, the
 * collection caps the field at 5 characters and the model declares it as an enum of one — so accepting
 * it from the client would only create a way to get it wrong, and a `type: 'point'` in the wrong case
 * is a document that fails validation for a reason no admin typed.
 */
export const validateAddress = (address: IAddressInput, prefix: string): ICompanyAddress => ({
	street: requiredText(address.street, `${prefix}.street`, MAX_ADDRESS),
	postalCode: textWithFormat(address.postalCode, `${prefix}.postalCode`, SHAPE_POSTAL_CODE, 'the postal code is 5 digits'),
	city: requiredText(address.city, `${prefix}.city`, MAX_CITY),
	province: textWithFormat(
		address.province,
		`${prefix}.province`,
		SHAPE_PROVINCE,
		'the province is the 2-letter code'
	).toUpperCase(),
	position: {
		type: POSITION_TYPE,
		coordinates: coordinate(address.position.coordinates, `${prefix}.position.coordinates`)
	}
})
