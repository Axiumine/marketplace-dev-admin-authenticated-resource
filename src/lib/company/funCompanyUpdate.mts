import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { ICompanyValidated } from '@lib/validate/validateCompany.mjs'
import { Company } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Company'
import { Types } from 'mongoose'

/**
 * Replaces a company's editable fields in one write.
 *
 * The whole card is one form and saves once, so this is one `$set` — and a single-document update is
 * atomic, unlike the nine round trips a per-field mutation would need.
 *
 * `address` is written **whole**, which is why the caller hands over an already-normalised object:
 * `$set: { address }` replaces the entire sub-document, and `validateCompany` is what guarantees no
 * member of it arrives as a `null` the collection validator would reject.
 *
 * `idShopOwner` is not in `ICompanyValidata` and so cannot be touched here. That is the point:
 * reassigning a company to a different owner is not a flow anybody has asked for.
 *
 * `matchedCount`, not `modifiedCount`: saving a card unchanged still matched, and that is a success —
 * the same convention as every other write on this tier.
 *
 * No `deleted` filter, like every other write on this tier: the filters sit on the read paths, which is
 * what keeps a soft-deleted company out of the Companies box. There is no page left that can reach this
 * with a deleted id, and `deleted` is not in `ICompanyValidata`, so a save cannot revive one either.
 */
export async function funCompanyUpdate(_id: Types.ObjectId, data: ICompanyValidated) {
	let ret

	try {
		ret = await Company.updateOne({ _id: _id }, { $set: data }).exec()
	} catch (e) {
		if (duplicateKey(e)) throwAlreadyTakenError('VAT number or certified email already registered by another company')

		throw e
	}

	if (ret.matchedCount !== 1) throwNotFoundError('company not found')
}
