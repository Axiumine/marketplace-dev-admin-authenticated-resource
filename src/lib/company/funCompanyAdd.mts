import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { ICompanyValidated } from '@lib/validate/validateCompany.mjs'
import mongoose, { trusted, Types } from 'mongoose'

/**
 * Creates one company under an existing shopOwner.
 *
 * The owner is checked first: `idShopOwner` reaches this from the URL of the admin's detail page,
 * `company` carries no foreign-key constraint — MongoDB has none — and the only read path is
 * `shopOwnerCompanies`, which lists by owner. An id that names nothing therefore inserts happily and
 * produces a company reachable only through the same wrong id that created it. A soft-deleted shopOwner
 * counts as absent on the same grounds.
 *
 * ⚠️ **The check and the create are one transaction, and the check is a write — mirroring
 * `funItemCategoryAdd`'s `throwIfParentNotTopLevel`.** A transaction alone is not enough: MongoDB
 * transactions are snapshot-isolated, not serialisable, so reading the owner as live, having
 * `funShopOwnerDelete` close the account, then writing the company still lets both transactions commit —
 * each saw a consistent snapshot, and neither saw the other's write. `funShopOwnerDelete` writes this
 * exact document (`ShopOwner.updateOne({ _id, deleted: … }, …)`), so touching it here with `$inc: { __v:
 * 1 }` puts both transactions on one document: they collide, the server aborts the loser with a
 * `WriteConflict`, `withTransaction` retries it, and the retry re-reads an owner the closure just
 * stamped — which this filter then reports as not found instead of creating a live company under a
 * soft-deleted owner. `__v` because nothing else reads it and the collection declares it `bsonType:
 * 'int'`, the same reasoning `throwIfParentNotTopLevel` documents in full.
 *
 * `_id` is minted here rather than left to mongoose: every model in marketplace-common declares `_id`
 * without a default, which switches auto-generation off, so `create()` on a document without one throws
 * before it reaches MongoDB. It is minted once, outside the transaction: a retried attempt writes
 * nothing, so re-using the id keeps the retry a repeat of the same create rather than a second one.
 *
 * `published: false` is stamped here rather than taken from the input: publishing is
 * `companyUpdatePublished`, a second call the admin makes on purpose. It is also the only value the
 * validator would accept from a shop this new — `published: true` needs a `slug` and a `publicName`,
 * both optional on the input.
 *
 * The duplicate-key message names both unique indexes — `vatNumber_unique` and `certifiedEmail_unique`, both globally
 * unique — because the driver's error does not say which one it tripped on and guessing would send the
 * admin to the wrong box. These are the two indexes that used to sit on the now-gone shop
 * collection's embedded `company.*` sub-document and made a company's second shop impossible; they are
 * the same rule, applied where it is true. Caught outside `withTransaction`, like `funItemCategoryAdd`'s
 * own: a duplicate key carries no transient label, so the transaction aborts and the error re-throws to
 * here untouched.
 *
 * Neither carries a `partialFilterExpression`, so a **deleted** company still occupies its VAT number
 * and this rejects the same one being registered again. Deliberate, and the same shape as
 * `shopOwner.login.email_unique`: a partial index would let two companies hold one VAT number the moment
 * a deleted company were restored, and there is no restore flow to make that safe.
 */
export async function funCompanyAdd(idShopOwner: Types.ObjectId, data: ICompanyValidated) {
	const _id = new Types.ObjectId()
	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			const owner = await ShopOwner.findOneAndUpdate(
				{ _id: idShopOwner, deleted: trusted({ $exists: false }) },
				{ $inc: { __v: 1 } },
				{ projection: { _id: 1 } }
			)
				.session(session)
				.lean()

			if (owner === null) throwNotFoundError('shopOwner not found')

			await Company.create([{ _id, idShopOwner, ...data, published: false }], { session })
		})
	} catch (e) {
		if (duplicateKey(e)) throwAlreadyTakenError('VAT number or certified email already registered by another company')

		throw e
	} finally {
		await session.endSession()
	}
}
