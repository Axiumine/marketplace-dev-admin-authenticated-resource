import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { throwIfParentNotTopLevel } from '@lib/itemCategory/throwIfParentNotTopLevel.mjs'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { IItemCategoryValidated } from '@lib/validate/validateItemCategory.mjs'
import { Types } from 'mongoose'

/**
 * Creates one category, at either of the taxonomy's two levels.
 *
 * The parent is checked first, and only when one was sent: an absent `idParent` is a top-level
 * category, which is the ordinary case and needs no read at all.
 *
 * `_id` is minted here rather than left to mongoose. Every model in marketplace-common declares `_id`
 * without a default, which switches auto-generation off, so `create()` on a document without one throws
 * before it reaches MongoDB.
 *
 * The duplicate-key message names `slug` alone because it is the collection's only unique index — and
 * it is unique **across both levels**, not within a parent, since `/category/:slug` and
 * `/category/:slug/:subSlug` share one namespace of first segments and two categories with one slug would be
 * two pages that cannot both exist.
 */
export async function funItemCategoryAdd(data: IItemCategoryValidated) {
	if (data.idParent !== undefined) await throwIfParentNotTopLevel(data.idParent)

	try {
		await ItemCategory.create({ _id: new Types.ObjectId(), ...data })
	} catch (e) {
		if (duplicateKey(e)) throwAlreadyTakenError('slug already used by another category')

		throw e
	}
}
