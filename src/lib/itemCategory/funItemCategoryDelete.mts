import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { trusted, Types } from 'mongoose'

/**
 * Marks one category deleted — a soft delete, like every other delete on this tier.
 *
 * **Refused while anything live still points at it**, which is not how `companyDel` behaves and is
 * deliberate. `item.idCategory` is required and MongoDB has no foreign keys, so retiring a category
 * under a stocked shop leaves every one of those items filed under a row no read path returns: the
 * items stay resolvable, the filter they belong to does not exist, and nothing anywhere would have
 * said so. A subcategory of a retired parent is the same failure one level up — unreachable from
 * `/category/:slug/:subSlug` while looking perfectly healthy in the collection.
 *
 * The alternative — cascade — was rejected: deleting one row would silently withdraw an unbounded
 * number of other shop owners' items, which is not a decision an operator should be able to take by
 * pressing Delete. Re-filing them first is the operator's call to make explicitly.
 *
 * Both counts filter `deleted`: a retired item or a retired subcategory is invisible everywhere and
 * cannot strand anything.
 *
 * `Date.now()`, a number, cast to the schema's `Date` path by mongoose on the way out. `matchedCount`,
 * not `modifiedCount`, and a 404 when nothing matched — same convention as the rest of this tier.
 */
export async function funItemCategoryDelete(_id: Types.ObjectId) {
	const children = await ItemCategory.countDocuments({ idParent: _id, deleted: trusted({ $exists: false }) }).lean()

	if (children > 0) throwErrorWrongUserInput('the category still has subcategories')

	const items = await Item.countDocuments({ idCategory: _id, deleted: trusted({ $exists: false }) }).lean()

	if (items > 0) throwErrorWrongUserInput('the category still holds items')

	const ret = await ItemCategory.updateOne({ _id: _id }, { $set: { deleted: Date.now() } }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('category not found')
}
