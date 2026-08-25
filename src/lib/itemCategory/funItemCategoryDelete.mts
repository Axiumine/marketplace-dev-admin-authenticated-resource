import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import mongoose, { trusted, Types } from 'mongoose'

/**
 * Marks one category deleted — a soft delete, like every other delete on this tier.
 *
 * **Refused while anything live still points at it**, which is not how `companyDel` behaves and is
 * deliberate. `item.idCategory` is required, so retiring a category under a stocked shop leaves
 * every one of those items filed under a category no read path returns: the items stay resolvable,
 * the filter they belong to does not exist, and nothing anywhere would have said so. A subcategory of
 * a retired parent is the same failure one level up — unreachable from `/category/:slug/:subSlug`
 * while looking perfectly healthy in the collection.
 *
 * The alternative — cascade — was rejected: deleting one category would silently withdraw an unbounded
 * number of other shop owners' items, which is not a decision an operator should be able to take by
 * pressing Delete. Re-filing them first is the operator's call to make explicitly.
 *
 * Both counts filter `deleted`: a retired item or a retired subcategory is invisible everywhere and
 * cannot strand anything.
 *
 * ⚠️ **The counts and the stamp are one transaction, and the subcategory half is closed by that.** A
 * subcategory being created under this category at the same instant is a create the count cannot see;
 * what makes it safe is that `itemCategoryAdd` files a child by writing its parent — this document —
 * so the two transactions collide on it, the loser is aborted with a `WriteConflict`, and
 * `withTransaction` retries it against the taxonomy the winner left. See `throwIfParentNotTopLevel`.
 *
 * ⚠️ **The item half is not closed and cannot be from here.** The write that races the item count is an
 * `itemAdd` on the ShopOwner tier, and it creates a document that does not exist yet — there is nothing
 * for this transaction to collide with. Closing it means the item write paths in
 * `marketplace-dev-authenticated-resource` touching the category they file under, the way this service's
 * own add does. Until then an item created in that instant can be left filed under a category retired
 * in the same one — the items stay resolvable, which is the reason a category is never hard-deleted.
 *
 * `Date.now()`, a number, cast to the schema's `Date` path by mongoose on the way out. `matchedCount`,
 * not `modifiedCount`, and a 404 when nothing matched — same convention as the rest of this tier.
 */
export async function funItemCategoryDelete(_id: Types.ObjectId) {
	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			const children = await ItemCategory.countDocuments({ idParent: _id, deleted: trusted({ $exists: false }) })
				.session(session)
				.lean()

			if (children > 0) throwErrorWrongUserInput('the category still has subcategories')

			const items = await Item.countDocuments({ idCategory: _id, deleted: trusted({ $exists: false }) })
				.session(session)
				.lean()

			if (items > 0) throwErrorWrongUserInput('the category still holds items')

			const ret = await ItemCategory.updateOne({ _id: _id }, { $set: { deleted: Date.now() } })
				.session(session)
				.exec()

			if (ret.matchedCount !== 1) throwNotFoundError('category not found')
		})
	} finally {
		await session.endSession()
	}
}
