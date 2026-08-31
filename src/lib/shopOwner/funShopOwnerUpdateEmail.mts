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
 * ⚠️ **Changing it now ends the shopOwner's sessions, and the revoke is not in here.** It was
 * true until 2026-08-13 that no write on this platform touched Redis; `adminUpdatePwd` changed that
 * first, exactly as the note that used to stand here predicted, and this write followed. The teardown
 * lives in the resolver — `shopOwnerUpdateEmail` calls `endEveryShopOwnerSession` after this returns —
 * because this helper's contract is one Mongo write and its collision, and a Redis client reached from
 * here would make every unit test of it a Redis test.
 *
 * The session key is still derived from the token rather than from the address, so nothing about the
 * old address expires on its own: the sessions have to be deleted, and that is what the caller does.
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
