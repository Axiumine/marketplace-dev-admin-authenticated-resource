import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { Types } from 'mongoose'

/**
 * The operator's free-text note about an account.
 *
 * **An empty note removes the field, it does not store `''`.** Same rule the two account flags follow
 * in `funImprenditoreUpdateStato`: the collection makes `note` optional, so "no note" already has a
 * spelling, and writing an empty string would leave two spellings of the same state — a later
 * `{ note: { $exists: true } }` query for annotated accounts (the obvious way to write it) would then
 * return every account whose note was ever cleared.
 *
 * `matchedCount`, not `modifiedCount`: 0 matched means no such imprenditore, which is a 404. A save
 * that changes nothing is not an error — the operator app refuses to submit a form that is not dirty,
 * and clearing a note that was already absent is still the state the operator asked for.
 */
export async function funImprenditoreUpdateNote(_id: Types.ObjectId, note: string) {
	const ret = await Imprenditore.updateOne({ _id: _id }, note === '' ? { $unset: { note: 1 } } : { $set: { note: note } }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('imprenditore non trovato')
}
