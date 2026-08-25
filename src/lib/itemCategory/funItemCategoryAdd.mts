import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { throwIfParentNotTopLevel } from '@lib/itemCategory/throwIfParentNotTopLevel.mjs'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { IItemCategoryValidated } from '@lib/validate/validateItemCategory.mjs'
import mongoose, { Types } from 'mongoose'

/**
 * Creates one category, at either of the taxonomy's two levels.
 *
 * The parent is checked first, and only when one was sent: an absent `idParent` is a top-level
 * category, which is the ordinary case and needs no read at all.
 *
 * ⚠️ **The check and the create are one transaction because apart they are not a rule.** Between a
 * parent that read as live and the child that gets written, `itemCategoryDel` can retire that parent —
 * it counts live children, finds none because this one does not exist yet, and stamps `deleted` — and
 * the taxonomy is left with a live subcategory under a retired parent, which is the exact document
 * `funItemCategoryDelete` refuses to create and which no read path can reach. The transaction alone does
 * not close that: it is snapshot isolation, and the two writes touch different documents. What closes it
 * is `throwIfParentNotTopLevel` reading the parent *with a write*, so the delete and this create collide
 * on one document; the loser is retried by `withTransaction` and then sees the parent it was given is
 * gone. See that function for why `__v` is the field it touches.
 *
 * `_id` is minted here rather than left to mongoose. Every model in marketplace-common declares `_id`
 * without a default, which switches auto-generation off, so `create()` on a document without one throws
 * before it reaches MongoDB. It is minted once, outside the callback: a retried transaction wrote
 * nothing, so re-using the id keeps the retry a repeat of the same create rather than a second one.
 *
 * `create` takes the array form because that is the only one that carries options, and the session has
 * to be one of them — a create outside the session would commit on its own and outlive an abort.
 *
 * The duplicate-key message names `slug` alone because it is the collection's only unique index — and
 * it is unique **across both levels**, not within a parent, since `/category/:slug` and
 * `/category/:slug/:subSlug` share one namespace of first segments and two categories with one slug would be
 * two pages that cannot both exist. It is caught outside `withTransaction` on purpose: a duplicate key
 * carries no transient label, so the transaction is aborted and the error re-thrown to here untouched.
 */
export async function funItemCategoryAdd(data: IItemCategoryValidated) {
	const _id = new Types.ObjectId()
	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			if (data.idParent !== undefined) await throwIfParentNotTopLevel(data.idParent, session)

			await ItemCategory.create([{ _id, ...data }], { session })
		})
	} catch (e) {
		if (duplicateKey(e)) throwAlreadyTakenError('slug already used by another category')

		throw e
	} finally {
		await session.endSession()
	}
}
