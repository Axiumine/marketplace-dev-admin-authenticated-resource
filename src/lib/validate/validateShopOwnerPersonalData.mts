import {
	IShopOwnerAddress,
	IShopOwnerPersonalData
} from '@axiumine/marketplace-common/models/MongoDBInterfaces/IShopOwnerPersonalData'
import {
	birthDate,
	coordinate,
	optionalText,
	requiredEmail,
	requiredText,
	SHAPE_POSTAL_CODE,
	SHAPE_PROVINCE,
	textWithFormat
} from '@lib/validate/fields.mjs'

/*
 * The bounds below are the `shopOwner` collection's own, read off
 * marketplace-db-setup/migrations/20260301000100-create-shopOwner.js. They are named rather than
 * inlined because two of them are easy to assume and wrong: an shopOwner's street address is capped
 * at 250, while the same field on an company is capped at 100 (see `validateAddress.mts`), and both
 * phone numbers are 12 — not the 15 an E.164 number can reach.
 */
const MAX_FIRST_NAME = 100
const MAX_LAST_NAME = 100
const MAX_ADDRESS = 250
const MAX_CITY = 100
const MAX_PHONE = 12

/** The only value `address.position.type` may hold — the Mongoose model declares it as an enum of one. */
const POSITION_TYPE = 'Point'

/**
 * What the admin-side `personalData` input carries: everything the stored shape has, except that the
 * address point is **optional** and is coordinates only.
 *
 * Both differences are deliberate. Optional, because the field was added long after the collection was
 * filled and cannot be back-derived from a street address — the operator app sends it the first time an
 * address is picked from the autocomplete and not before. Coordinates only, because `type` has exactly
 * one legal value and accepting it from the client would only create a way to get it wrong — the same
 * reasoning `validateAddress.mts` applies to the company address.
 */
export type IShopOwnerPersonalDataInput = Omit<IShopOwnerPersonalData, 'address'> & {
	address: Omit<IShopOwnerAddress, 'position'> & { position?: { coordinates: number[] } | null }
}

/**
 * Checks and normalises an incoming `personalData` before it replaces the stored one.
 *
 * Returns a **new** object rather than mutating the argument, and the caller writes that: the returned
 * value is trimmed, has its province upper-cased, and — the part that matters for the write — carries
 * no key at all for a landline that was left blank. `$set: { personalData }` replaces the whole
 * sub-document, so a `landline` present with value `null` or `undefined` is not "unchanged", it is a value
 * of the wrong type for a `bsonType: 'string'` property and it fails the entire update.
 *
 * `today` is threaded in rather than read from the clock here so the majority boundary is testable from
 * both sides without freezing time.
 */
export const validateShopOwnerPersonalData = (
	personalData: IShopOwnerPersonalDataInput,
	today: Date
): IShopOwnerPersonalData => {
	const landline = optionalText(personalData.contacts.landline, 'contacts.landline', MAX_PHONE)

	// `== null` on purpose: absent and explicitly null both mean "this address has no point", and the
	// GraphQL input makes the field nullable, so the client can send either.
	const position = personalData.address.position == null ? undefined : personalData.address.position

	return {
		firstName: requiredText(personalData.firstName, 'firstName', MAX_FIRST_NAME),
		lastName: requiredText(personalData.lastName, 'lastName', MAX_LAST_NAME),
		birth: { date: birthDate(personalData.birth.date, 'birth.date', today) },
		address: {
			street: requiredText(personalData.address.street, 'address.street', MAX_ADDRESS),
			postalCode: textWithFormat(
				personalData.address.postalCode,
				'address.postalCode',
				SHAPE_POSTAL_CODE,
				'the postal code is 5 digits'
			),
			city: requiredText(personalData.address.city, 'address.city', MAX_CITY),
			// Upper-cased on the way in, so `mi` and `MI` are one value in the database rather than two
			// that sort apart and compare unequal. The pattern accepts either case on purpose — refusing
			// a lower-case province code would be a validation error over something the server can simply fix.
			province: textWithFormat(
				personalData.address.province,
				'address.province',
				SHAPE_PROVINCE,
				'the province is the 2-letter code'
			).toUpperCase(),
			// Spread rather than `position: undefined`, for the same reason `landline` is spread below:
			// `$set: { personalData }` replaces the whole sub-document and the BSON serialiser encodes an
			// explicit `undefined` as `null`, which `bsonType: 'object'` rejects. An address saved
			// without a point therefore stores no `position` key at all.
			...(position === undefined
				? {}
				: {
						position: {
							type: POSITION_TYPE,
							coordinates: coordinate(position.coordinates, 'address.position.coordinates')
						}
					})
		},
		contacts: {
			mobile: requiredText(personalData.contacts.mobile, 'contacts.mobile', MAX_PHONE),
			// Spread, not `landline: undefined`. The key has to be absent from the object, not present
			// holding nothing: the BSON serialiser encodes an explicit `undefined` as `null` unless
			// `ignoreUndefined` is set, and `null` is what the collection validator rejects.
			...(landline === undefined ? {} : { landline }),
			email: requiredEmail(personalData.contacts.email, 'contacts.email')
		}
	}
}
