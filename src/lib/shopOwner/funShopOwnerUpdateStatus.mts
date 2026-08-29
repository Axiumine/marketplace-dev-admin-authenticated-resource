import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { unpublishOwnerStorefront } from '@lib/shopOwner/unpublishOwnerStorefront.mjs'
import mongoose, { Types } from 'mongoose'

/**
 * One object rather than four positional arguments, and that is not a style choice: `disabled` and
 * `waitApprov` are adjacent booleans with different meanings, so a positional list makes swapping them a
 * silent suspension of an account that was only awaiting approval. `revokeAllSessionsForAccount` on this
 * tier already takes its arguments this way for the same reason.
 */
export interface IShopOwnerStatus {
	_id: Types.ObjectId
	disabled: boolean
	waitApprov: boolean
	/** The operator making the change — `ctx.state.user._id`, never anything from the request body. */
	adminId: Types.ObjectId
	/** Present exactly when `disabled` is true; `validateDisabledReason` is what guarantees that. */
	disabledReason?: string
}

/**
 * The two account flags an operator can flip: the disable switch and the manual-approval gate.
 *
 * **False removes the field, it does not store `false`.** Both flags are documented in the collection
 * validator as "present and true: blocked; absent: login allowed", and `funShopOwnerDelete` already
 * `$unset`s `waitApprov` rather than writing false. Storing `false` would be legal BSON and would still
 * behave correctly everywhere — `checkUserAuthorizationDisDel` tests truthiness — but it would leave the
 * collection holding two spellings of the same state, and a later `{ waitApprov: { $exists: true } }`
 * query for the approval queue (the obvious way to write it) would return every account ever approved.
 *
 * ⚠️ **A suspension names its actor and its reason, and the three `disabled*` fields move together**
 * (ADR-044). Suspending writes `disabledBy` and `disabledReason` beside the flag; releasing `$unset`s all
 * three. They are the account's *latest status*, not its history — a stale reason standing beside a live
 * account is worse than none — and nothing here keeps a record of a suspension that has been lifted.
 * `disabledReason` is encrypted on the way past by the model's plugin, so the plaintext string goes into
 * the `$set` and ciphertext reaches the server; the collection's `dependencies` rule then refuses any
 * `disabled: true` that arrived without one, which is the half of the contract a service cannot lose.
 *
 * ⚠️ **Suspending takes the owner's storefront off air, in this transaction** (ADR-045). Releasing puts
 * nothing back: the owner republishes their shops and items by hand, with the ShopOwner tier's bulk
 * control. See `unpublishOwnerStorefront` — the temptation to add the inverse belongs there.
 *
 * ⚠️ **`waitApprov` deliberately does not cascade.** Re-gating an owner to awaiting-approval leaves their
 * shop live, which is arguably the same position a suspension puts them in; nobody has asked the
 * question, and answering it by analogy is how the gap ADR-045 closes was created in the first place.
 *
 * `deleted` is deliberately not here. It is a timestamp, it is what `shopOwnerDel` writes, and lifting one
 * is not this mutation's to do — a closed account comes back through the registration flow (ADR-046).
 *
 * `matchedCount`, not `modifiedCount`: the sibling `funShopOwnerUpdate` uses `modifiedCount !== 1`,
 * which reports "you saved without changing anything" as a 500 (its test pins that as current
 * behaviour). New code does not copy it. Here 0 matched means no such shopOwner, which is a 404, and
 * a no-op save is not an error — the operator app already refuses to submit a form that is not dirty,
 * and a flag re-set to the value it already held is still the state the operator asked for. Raising the
 * 404 *inside* the transaction is what stops a cascade running over an id that matched nothing.
 */
export async function funShopOwnerUpdateStatus({ _id, disabled, waitApprov, adminId, disabledReason }: IShopOwnerStatus) {
	const set: Record<string, unknown> = {}
	const unset: Record<string, 1> = {}

	if (disabled) {
		set.disabled = true
		set.disabledBy = adminId
		set.disabledReason = disabledReason
	} else {
		unset.disabled = 1
		unset.disabledBy = 1
		unset.disabledReason = 1
	}

	if (waitApprov) set.waitApprov = true
	else unset.waitApprov = 1

	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			// `$set` and `$unset` are always both present but never both non-empty for the same path, so no
			// "Updating the path 'x' would create a conflict" is possible. An empty operator object is accepted
			// by the driver and does nothing.
			const ret = await ShopOwner.updateOne({ _id: _id }, { $set: set, $unset: unset }).session(session).exec()

			if (ret.matchedCount !== 1) throwNotFoundError('shopOwner not found')

			if (disabled) await unpublishOwnerStorefront(_id, session)
		})
	} finally {
		await session.endSession()
	}
}
