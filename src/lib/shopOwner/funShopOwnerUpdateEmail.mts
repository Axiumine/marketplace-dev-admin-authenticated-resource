import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { duplicateKey } from '@lib/mongo/duplicateKey.mjs'
import { Types } from 'mongoose'

/**
 * Changes the address an shopOwner logs in with.
 *
 * Its own mutation rather than a field of `shopOwnerUpdate`, because it is a different thing:
 * `personalData.contacts.email` is where the platform writes to a person, `login.email` is half of a
 * credential and is the collection's one unique index. Editing it can collide, and collisions are the
 * only reason this helper is not two lines.
 *
 * ⚠️ Changing it does **not** invalidate the account's Redis sessions. The session key is derived from
 * the token, not from the address, so an shopOwner logged in when the operator edits this stays
 * logged in and simply signs in with the new address next time. That is the current behaviour of every
 * write on the platform, not a decision taken here — if it ever needs to change, it changes for
 * `adminUpdatePwd` first.
 *
 * `matchedCount`, not `modifiedCount` — see `funShopOwnerUpdateStatus` for why.
 */
export async function funShopOwnerUpdateEmail(_id: Types.ObjectId, email: string) {
	let ret

	try {
		ret = await ShopOwner.updateOne({ _id: _id }, { $set: { 'login.email': email } }).exec()
	} catch (e) {
		// Only the `login.email_unique` index can raise 11000 on this update, so the message can name
		// the field without inspecting `keyPattern`.
		if (duplicateKey(e)) throwAlreadyTakenError('email: address already registered by another shopOwner')

		throw e
	}

	if (ret.matchedCount !== 1) throwNotFoundError('shopOwner not found')
}
