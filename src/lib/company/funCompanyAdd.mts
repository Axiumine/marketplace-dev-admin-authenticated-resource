import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { ICompanyValidated } from '@lib/validate/validateCompany.mjs'
import { trusted, Types } from 'mongoose'

/**
 * Creates one company under an existing shopOwner.
 *
 * The owner is checked first: `idShopOwner` reaches this from the URL of the operator's detail page,
 * `company` carries no foreign-key constraint — MongoDB has none — and the only read path is
 * `shopOwnerCompanies`, which lists by owner. An id that names nothing therefore inserts happily and
 * produces a company reachable only through the same wrong id that created it. A soft-deleted shopOwner
 * counts as absent on the same grounds.
 *
 * `_id` is minted here rather than left to mongoose: every model in marketplace-common declares `_id`
 * without a default, which switches auto-generation off, so `create()` on a document without one throws
 * before it reaches MongoDB.
 *
 * `published: false` is stamped here rather than taken from the input: publishing is
 * `companyUpdatePublished`, a second call the operator makes on purpose. It is also the only value the
 * validator would accept from a shop this new — `published: true` needs a `slug` and a `publicName`,
 * both optional on the input.
 *
 * The duplicate-key message names both unique indexes — `vatNumber_unique` and `certifiedEmail_unique`, both globally
 * unique — because the driver's error does not say which one it tripped on and guessing would send the
 * operator to the wrong box. These are the two indexes that used to sit on the now-gone shop
 * collection's embedded `company.*` sub-document and made a company's second shop impossible; they are
 * the same rule, applied where it is true.
 *
 * Neither carries a `partialFilterExpression`, so a **deleted** company still occupies its VAT number
 * and this rejects the same one being registered again. Deliberate, and the same shape as
 * `shopOwner.login.email_unique`: a partial index would let two companies hold one VAT number the moment
 * a deleted company were restored, and there is no restore flow to make that safe.
 */
export async function funCompanyAdd(idShopOwner: Types.ObjectId, data: ICompanyValidated) {
	const owner = await ShopOwner.exists({ _id: idShopOwner, deleted: trusted({ $exists: false }) })

	if (owner === null) throwNotFoundError('shopOwner not found')

	try {
		await Company.create({ _id: new Types.ObjectId(), idShopOwner, ...data, published: false })
	} catch (e) {
		if (duplicateKey(e)) throwAlreadyTakenError('VAT number or certified email already registered by another company')

		throw e
	}
}
