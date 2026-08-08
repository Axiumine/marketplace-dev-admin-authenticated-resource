import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { Types } from 'mongoose'

/**
 * Removes one item from the platform — a soft delete, like every other delete on this tier.
 *
 * Unlike the owner's `itemDel` on 4026 this carries no ownership clause, because an operator owns
 * nothing and is owned by nothing: the whole point of the tier is acting on rows that belong to
 * somebody else. The 404 is therefore the only guard, and it is a real one — an id that names no item
 * is a stale client, not a silent success.
 *
 * A stamp rather than a removal, so the unique `{ idCompany, slug }` index stays occupied: a link that
 * used to be an item should not silently become a different item when the shop reuses the name.
 *
 * `Date.now()`, a number, cast to the schema's `Date` path by mongoose on the way out. No `deleted`
 * filter on the write itself: a re-delete stamps a fresh instant, which is the state the operator asked
 * for, and the row is invisible to every read path either way.
 */
export async function funItemDelete(_id: Types.ObjectId) {
	const ret = await Item.updateOne({ _id: _id }, { $set: { deleted: Date.now() } }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('item not found')
}
