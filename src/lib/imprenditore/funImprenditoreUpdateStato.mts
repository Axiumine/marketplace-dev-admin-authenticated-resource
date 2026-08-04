import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { Types } from 'mongoose'

/**
 * The two account flags an operator can flip: the disable switch and the manual-approval gate.
 *
 * **False removes the field, it does not store `false`.** Both flags are documented in the collection
 * validator as "se presente e true: …, se assente: login permesso", and `funImprenditoreDelete` already
 * `$unset`s `waitApprov` rather than writing false. Storing `false` would be legal BSON and would still
 * behave correctly everywhere — `checkUserAuthorizationDisDel` tests truthiness — but it would leave the
 * collection holding two spellings of the same state, and a later `{ waitApprov: { $exists: true } }`
 * query for the approval queue (the obvious way to write it) would return every account ever approved.
 *
 * `deleted` is deliberately not here. It is a timestamp, it is what `imprenditoreDel` writes, and an
 * undelete is a decision nobody has taken — the detail page renders it read-only for that reason.
 *
 * `matchedCount`, not `modifiedCount`: the sibling `funImprenditoreUpdate` uses `modifiedCount !== 1`,
 * which reports "you saved without changing anything" as a 500 (its test pins that as current
 * behaviour). New code does not copy it. Here 0 matched means no such imprenditore, which is a 404, and
 * a no-op save is not an error — the operator app already refuses to submit a form that is not dirty,
 * and a flag re-set to the value it already held is still the state the operator asked for.
 */
export async function funImprenditoreUpdateStato(_id: Types.ObjectId, disabled: boolean, waitApprov: boolean) {
	const set: Record<string, true> = {}
	const unset: Record<string, 1> = {}

	if (disabled) set.disabled = true
	else unset.disabled = 1

	if (waitApprov) set.waitApprov = true
	else unset.waitApprov = 1

	// `$set` and `$unset` are always both present but never both non-empty for the same path, so no
	// "Updating the path 'x' would create a conflict" is possible. An empty operator object is accepted
	// by the driver and does nothing.
	const ret = await Imprenditore.updateOne({ _id: _id }, { $set: set, $unset: unset }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('imprenditore non trovato')
}
