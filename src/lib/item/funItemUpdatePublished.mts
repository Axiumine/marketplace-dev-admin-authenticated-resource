import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Item } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Item'
import { Types } from 'mongoose'

/**
 * The moderation switch: takes an item off the public site, or puts it back.
 *
 * The whole of the operator's write access to a shop's catalogue, beside `itemDel`. An operator does
 * not author items — the shop owner does, on 4026 — so this is one flag and not a save of the row.
 *
 * ⚠️ **Nothing records that it was an operator who flipped it.** The owner sees an unpublished item and
 * can publish it again from their own tier, which makes this a takedown that does not stick. That is
 * the honest state of the platform today: a moderation log, or a flag the owner cannot clear, is a
 * second field and a policy decision nobody has taken. Written down rather than half-built.
 *
 * `published` is stored as `false`, not `$unset` — unlike `shopOwner.disabled`, whose validator
 * documents it as present-and-true or absent. `item.published` is in the collection's `required` array,
 * so unsetting it fails the write.
 *
 * `matchedCount`, not `modifiedCount`: re-publishing something already published is the state the
 * operator asked for, and a no-op is not an error.
 */
export async function funItemUpdatePublished(_id: Types.ObjectId, published: boolean) {
	const ret = await Item.updateOne({ _id: _id }, { $set: { published } }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('item not found')
}
