import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { Types } from 'mongoose'

/** One object rather than three positional arguments, for the reason `IShopOwnerStatus` gives. */
export interface IUserStatus {
	_id: Types.ObjectId
	disabled: boolean
	/** The operator making the change — `ctx.state.user._id`, never anything from the request body. */
	adminId: Types.ObjectId
	/** Present exactly when `disabled` is true; `validateDisabledReason` is what guarantees that. */
	disabledReason?: string
}

/**
 * The one account flag an operator can flip on a customer: the disable switch.
 *
 * ⚠️ **`disabled` is the only flag, and the collection has no second one to add later.** `waitApprov` is a
 * `shopOwner` field and a customer will never carry one — the approval gate was closed on 2026-08-25
 * (`phase5/CUSTOMER_ACCOUNT_ADDRESSES.md` §6, ADR-INDEX §4), so nothing before a customer's first login stands between them and
 * the platform, and this is the only lever there is after it.
 *
 * **False removes the field, it does not store `false`**, exactly as `funShopOwnerUpdateStatus` does and
 * for the same reason: the validator documents the flag as "present and true: blocked; absent: login
 * allowed", every reader of it tests truthiness — `tryLoginUser`, `tokenInfoUser`, `funUserUpdatePwd` and
 * the two path maps in public-resource — and storing `false` would leave the collection holding two
 * spellings of one state, which a later `{ disabled: { $exists: true } }` would read as "suspended".
 * `usersActiveTbl` already filters exactly that way.
 *
 * ⚠️ **A suspension names its actor and its reason, and the three `disabled*` fields move together**
 * (ADR-044) — the customer tier carries the identical trio, written and cleared as one. `disabledReason`
 * is `ALGORITHM_RANDOM`-encrypted, and the plaintext in the `$set` below is ciphertext by the time it
 * leaves the process: the model's plugin rewrites `$set` operands on the way past, which is what makes a
 * plaintext write of an encrypted path on this collection correct rather than a validator rejection. What
 * the plugin cannot rewrite is an aggregation-pipeline update, so this must stay an ordinary one.
 *
 * ⚠️ **No cascade here, and none is missing.** A customer owns no company and no item — the FK chain runs
 * `shopOwner → company → item` and `user` sits outside it (ADR-045 touches nothing on this tier).
 *
 * ⚠️ **There is no closure counterpart on this tier for an operator to call.** A customer closes their own
 * account through `funUserDel`, which stamps `deleted` and never touches any `disabled*` field: `deleted`
 * is the subject giving the account up, `disabled` is the platform taking it away, and a path that could
 * write the second could lift a sanction against itself.
 *
 * `matchedCount`, not `modifiedCount`: 0 matched means no such customer, which is a 404; a flag re-set to
 * the value it already held is still the state the operator asked for and not an error.
 */
export async function funUserUpdateStatus({ _id, disabled, adminId, disabledReason }: IUserStatus) {
	// `$set` and `$unset` are never both present here — one flag, one branch — so no
	// "Updating the path 'disabled' would create a conflict" is possible.
	const update = disabled
		? { $set: { disabled: true, disabledBy: adminId, disabledReason: disabledReason } }
		: { $unset: { disabled: 1, disabledBy: 1, disabledReason: 1 } }

	const ret = await User.updateOne({ _id: _id }, update).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('user not found')
}
