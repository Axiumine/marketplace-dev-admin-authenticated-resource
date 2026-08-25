import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { Types } from 'mongoose'

/**
 * The one account flag an operator can flip on a customer: the disable switch.
 *
 * ⚠️ **`disabled` is the only flag, and the collection has no second one to add later.** `waitApprov` is a
 * `shopOwner` field and a customer will never carry one — the approval gate was closed on 2026-08-25
 * (`epics/E07.md` §6, ADR-INDEX §4), so nothing before a customer's first login stands between them and
 * the platform, and this is the only lever there is after it.
 *
 * **False removes the field, it does not store `false`**, exactly as `funShopOwnerUpdateStatus` does and
 * for the same reason: the validator documents the flag as "present and true: blocked; absent: login
 * allowed", every reader of it tests truthiness — `tryLoginUser`, `tokenInfoUser`, `funUserUpdatePwd` and
 * the two path maps in public-resource — and storing `false` would leave the collection holding two
 * spellings of one state, which a later `{ disabled: { $exists: true } }` would read as "suspended".
 * `usersActiveTbl` already filters exactly that way.
 *
 * ⚠️ **`$set` is not usable on this collection for a field that is not `disabled`.** `user` is encrypted
 * whole (ADR-029), and a plaintext `$set` of an encrypted path would be refused by the validator's
 * `binData` declaration. `disabled` was never encrypted — it is a login gate the driver has to read
 * without a key — which is what makes this write a plain `updateOne` rather than a CSFLE round trip.
 *
 * `matchedCount`, not `modifiedCount`: 0 matched means no such customer, which is a 404; a flag re-set to
 * the value it already held is still the state the operator asked for and not an error.
 */
export async function funUserUpdateStatus(_id: Types.ObjectId, disabled: boolean) {
	// `$set` and `$unset` are never both non-empty here — one flag, one branch — so no
	// "Updating the path 'disabled' would create a conflict" is possible. An empty operator object is
	// accepted by the driver and does nothing.
	const update = disabled ? { $set: { disabled: true } } : { $unset: { disabled: 1 } }

	const ret = await User.updateOne({ _id: _id }, update).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('user not found')
}
