import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Types } from 'mongoose'

/**
 * Marks one company deleted.
 *
 * **A soft delete, like every other delete on this tier.** The document stays and gains a `deleted` instant;
 * every read path filters it out with `deleted: { $exists: false }`, so the company disappears from the
 * admin's page without the document going anywhere.
 *
 * The consequence to know about: `vatNumber_unique` and `certifiedEmail_unique` are plain global unique indexes with no
 * `partialFilterExpression`, so a deleted company keeps its VAT number occupied and the same one
 * cannot be registered again. That is deliberate — it matches `shopOwner.login.email_unique`, and a
 * partial index would let two companies carry the same VAT number the moment one of them is restored.
 *
 * Until 2026-08-04 this refused while any live document on the now-gone shop collection still
 * pointed at this company — that collection carried `idCompany` as its own reference. It is gone along with every
 * reference to it — a shop IS a `company`; there is no shop collection and will not be one — so there
 * is nothing left to check before the company is stamped.
 *
 * `Date.now()`, a number, cast to the schema's `Date` path by mongoose on the way out. The write carries
 * no `deleted` filter of its own: a re-delete stamps a fresh instant and is the state the admin asked
 * for, while the company is unreachable from any page anyway.
 *
 * `matchedCount`, not `modifiedCount`, and a 404: 0 matched means no such company, which the admin
 * can act on. Same convention as every other write on this tier.
 */
export async function funCompanyDelete(_id: Types.ObjectId) {
	const ret = await Company.updateOne({ _id: _id }, { $set: { deleted: Date.now() } }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('company not found')
}
