import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { Types } from 'mongoose'

/**
 * The admin's free-text note about an account.
 *
 * **An empty note removes the field, it does not store `''`.** Same rule the two account flags follow
 * in `funShopOwnerUpdateStatus`: the collection makes `notes` optional, so "no note" already has a
 * spelling, and writing an empty string would leave two spellings of the same state — a later
 * `{ notes: { $exists: true } }` query for annotated accounts (the obvious way to write it) would then
 * return every account whose note was ever cleared.
 *
 * `matchedCount`, not `modifiedCount`: 0 matched means no such shopOwner, which is a 404. A save
 * that changes nothing is not an error — the admin app refuses to submit a form that is not dirty,
 * and clearing a note that was already absent is still the state the admin asked for.
 */
export async function funShopOwnerUpdateNote(_id: Types.ObjectId, notes: string) {
	const ret = await ShopOwner.updateOne(
		{ _id: _id },
		notes === '' ? { $unset: { notes: 1 } } : { $set: { notes: notes } }
	).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('shopOwner not found')
}
