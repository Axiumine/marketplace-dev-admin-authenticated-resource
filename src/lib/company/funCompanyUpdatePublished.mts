import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Types } from 'mongoose'

/**
 * The moderation switch for a whole shop: takes it off the public site, or puts it back.
 *
 * The same shape as `funItemUpdatePublished`, one level up the chain — and it is the level that
 * matters, because `item.published` composes with this one: an item is publicly visible only if its
 * company is published too, so unpublishing here hides the shop's whole catalogue in one write.
 *
 * ⚠️ **Nothing records that it was an operator who flipped it.** The owner can publish the shop again
 * from 4026, which makes this a takedown that does not stick — the same honest limitation the item
 * switch carries, and the same reason: a moderation log, or a flag the owner cannot clear, is a second
 * field and a policy decision nobody has taken.
 *
 * ⚠️ **`published: true` can be refused by the database.** The collection's `$expr` demands a stored
 * `slug` and `publicName` beside it, and an `$expr` runs on updates as well as inserts, so a shop whose
 * card has never been filled in cannot be published from here. That check is deliberately not repeated
 * in application code: two copies of one rule drift, and the copy in the database is the one no write
 * can bypass. The driver's rejection reaches the operator through `tryCatchRethrow`.
 *
 * `matchedCount`, not `modifiedCount`: re-publishing something already published is the state the
 * operator asked for, and a no-op is not an error.
 */
export async function funCompanyUpdatePublished(_id: Types.ObjectId, published: boolean) {
	const ret = await Company.updateOne({ _id: _id }, { $set: { published } }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('company not found')
}
