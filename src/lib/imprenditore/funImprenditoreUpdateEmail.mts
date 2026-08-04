import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { chiaveDuplicata } from '@lib/mongo/chiaveDuplicata.mjs'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { Types } from 'mongoose'

/**
 * Changes the address an imprenditore logs in with.
 *
 * Its own mutation rather than a field of `imprenditoreUpdate`, because it is a different thing:
 * `anagrafica.contatti.email` is where the platform writes to a person, `login.email` is half of a
 * credential and is the collection's one unique index. Editing it can collide, and collisions are the
 * only reason this helper is not two lines.
 *
 * ⚠️ Changing it does **not** invalidate the account's Redis sessions. The session key is derived from
 * the token, not from the address, so an imprenditore logged in when the operator edits this stays
 * logged in and simply signs in with the new address next time. That is the current behaviour of every
 * write on the platform, not a decision taken here — if it ever needs to change, it changes for
 * `adminUpdatePwd` first.
 *
 * `matchedCount`, not `modifiedCount` — see `funImprenditoreUpdateStato` for why.
 */
export async function funImprenditoreUpdateEmail(_id: Types.ObjectId, email: string) {
	let ret

	try {
		ret = await Imprenditore.updateOne({ _id: _id }, { $set: { 'login.email': email } }).exec()
	} catch (e) {
		// Only the `login.email_unique` index can raise 11000 on this update, so the message can name
		// the field without inspecting `keyPattern`.
		if (chiaveDuplicata(e)) throwAlreadyTakenError('email: indirizzo già registrato da un altro imprenditore')

		throw e
	}

	if (ret.matchedCount !== 1) throwNotFoundError('imprenditore non trovato')
}
