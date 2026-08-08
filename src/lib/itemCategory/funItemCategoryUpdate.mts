import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { throwIfHasChildren } from '@lib/itemCategory/throwIfHasChildren.mjs'
import { throwIfParentNotTopLevel } from '@lib/itemCategory/throwIfParentNotTopLevel.mjs'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { IItemCategoryValidated } from '@lib/validate/validateItemCategory.mjs'
import { Types } from 'mongoose'

/**
 * Saves one category, whole, in a single atomic write.
 *
 * ⚠️ **Both halves of the depth cap run here, and both are needed.** Filing this category under a parent
 * requires the parent to be top-level (`throwIfParentNotTopLevel`, looking up) *and* this category to have
 * no subcategories of its own (`throwIfHasChildren`, looking down) — a category with children that
 * gains a parent pushes every one of those children to the third level without a single write naming
 * them.
 *
 * `$unset` when `idParent` is absent, not `$set: { idParent: null }`: the collection declares it
 * `bsonType: 'objectId'` under `additionalProperties: false`, so a null fails the write outright, and
 * "no parent" is spelled by the field not being there. Promoting a subcategory back to the top level is
 * exactly that write, so it has to work.
 *
 * `$set` and `$unset` never name the same path — `idParent` is in one or the other, never both — so no
 * "Updating the path 'idParent' would create a conflict" is possible. An empty operator object is
 * accepted by the driver and does nothing.
 *
 * `matchedCount`, not `modifiedCount`: saving a category unchanged still matched, and that is a
 * success. Same convention as every other write on this tier.
 */
export async function funItemCategoryUpdate(_id: Types.ObjectId, data: IItemCategoryValidated) {
	if (data.idParent !== undefined) {
		await throwIfParentNotTopLevel(data.idParent, _id)
		await throwIfHasChildren(_id)
	}

	const { idParent, ...rest } = data
	const set = idParent === undefined ? rest : { ...rest, idParent }
	const unset = idParent === undefined ? { idParent: 1 } : {}

	let ret

	try {
		ret = await ItemCategory.updateOne({ _id: _id }, { $set: set, $unset: unset }).exec()
	} catch (e) {
		if (duplicateKey(e)) throwAlreadyTakenError('slug already used by another category')

		throw e
	}

	if (ret.matchedCount !== 1) throwNotFoundError('category not found')
}
