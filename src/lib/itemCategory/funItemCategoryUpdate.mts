import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { throwIfHasChildren } from '@lib/itemCategory/throwIfHasChildren.mjs'
import { throwIfParentNotTopLevel } from '@lib/itemCategory/throwIfParentNotTopLevel.mjs'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { IItemCategoryValidated } from '@lib/validate/validateItemCategory.mjs'
import mongoose, { Types } from 'mongoose'

/**
 * Saves one category, whole, in a single atomic write.
 *
 * ⚠️ **Both halves of the depth cap run here, and both are needed.** Filing this category under a parent
 * requires the parent to be top-level (`throwIfParentNotTopLevel`, looking up) *and* this category to have
 * no subcategories of its own (`throwIfHasChildren`, looking down) — a category with children that
 * gains a parent pushes every one of those children to the third level without a single write naming
 * them.
 *
 * ⚠️ **Both halves are read-then-write, so both run in one transaction with the save they guard.**
 * Checked apart from the write, each has a window: the parent that read as top-level can be given a
 * parent of its own, and the category that read as childless can be handed a child, between the check
 * and the `updateOne` — and the result is a third level that no single write ever named. The transaction
 * makes the three operations one, and the collision the retry needs is already there: this update writes
 * the document `itemCategoryAdd` would have to touch to file a child under it, and
 * `throwIfParentNotTopLevel` writes the parent that a concurrent `itemCategoryDel` would stamp. Whichever
 * pair races, the two transactions meet on one document, one is aborted with a `WriteConflict`, and
 * `withTransaction` retries it against the taxonomy the winner left.
 *
 * `$unset` when `idParent` is absent, not `$set: { idParent: null }`: the collection declares it
 * `bsonType: 'objectId'` under `additionalProperties: false`, so a null fails the write outright, and
 * "no parent" is spelled by the field not being there. Promoting a subcategory back to the top level is
 * exactly that write, so it has to work.
 *
 * `$set` and `$unset` never name the same path — `idParent` is in one or the other, never both — so no
 * "Updating the path 'idParent' would create a conflict" is possible. An empty admin object is
 * accepted by the driver and does nothing.
 *
 * `matchedCount`, not `modifiedCount`: saving a category unchanged still matched, and that is a
 * success. Same convention as every other write on this tier. The 404 is thrown inside the transaction,
 * which aborts it — there is nothing to keep when the document the save names does not exist.
 */
export async function funItemCategoryUpdate(_id: Types.ObjectId, data: IItemCategoryValidated) {
	const { idParent, ...rest } = data
	const set = idParent === undefined ? rest : { ...rest, idParent }
	const unset = idParent === undefined ? { idParent: 1 } : {}

	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			if (data.idParent !== undefined) {
				await throwIfParentNotTopLevel(data.idParent, session, _id)
				await throwIfHasChildren(_id, session)
			}

			const ret = await ItemCategory.updateOne({ _id: _id }, { $set: set, $unset: unset }).session(session).exec()

			if (ret.matchedCount !== 1) throwNotFoundError('category not found')
		})
	} catch (e) {
		if (duplicateKey(e)) throwAlreadyTakenError('slug already used by another category')

		throw e
	} finally {
		await session.endSession()
	}
}
