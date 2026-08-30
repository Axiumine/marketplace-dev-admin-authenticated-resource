import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { trusted, Types } from 'mongoose'

/**
 * Closes a customer's account on the admin's authority: a stamp, never a removal.
 *
 * ⚠️ **`deletedBy` is what says an admin did this** (ADR-044). The field is an `admin._id` and its
 * *absence* beside a `deleted` stamp is the record that the account holder closed it themselves through
 * `funUserDel` on their own tier — which is why nothing here writes a collection name alongside the id.
 * There is exactly one possible actor collection per stamp, so the field's own name carries it; a second
 * field saying which would be a `role` field arriving by the back door, and ADR-002 refuses that.
 *
 * ⚠️ **The filter refuses an account that is already closed, and that is a retention rule rather than
 * tidiness.** `deleted` starts the thirty-day clock ADR-041 measures and ADR-046 makes an undo window, so
 * a second closure over the same document would push the scrub thirty days further out and postpone the
 * erasure the first one promised. Matching nothing here answers 404 — the account is gone as far as this
 * mutation is concerned — instead of silently resetting the clock. `trusted()` is not optional:
 * `sanitizeFilter` is global and strips a bare `$exists`.
 *
 * ⚠️ **A closure does not touch the `disabled*` trio, in either direction.** A suspended customer closed
 * by an admin stays suspended, and ADR-046 restores the document with the trio exactly as it found it —
 * so a closure is not a way to launder a sanction away, and the undo window is not a way back in. The two
 * states answer different questions: `deleted` is whether the account is still held, `disabled` is
 * whether it may be used.
 *
 * ⚠️ **No cascade, and none is missing.** A customer owns no company and no item — the FK chain runs
 * `shopOwner → company → item` and `user` sits outside it, so ADR-045's storefront withdrawal has no
 * counterpart on this tier. That is also why there is no transaction: one write cannot be half-applied,
 * and `mongoose.startSession()` here would buy nothing but a round trip. `funShopOwnerDelete` opens one
 * because its stamp and its cascade must land together.
 *
 * There is no `waitApprov` to drop either: the customer approval gate was closed permanently on
 * 2026-08-25, so nothing puts a customer in a queue this could leave them sitting in.
 *
 * `new Date()`, not `Date.now()`: the retention sweep compares `deleted` against a cutoff and the model's
 * path is a `Date`. Mongoose casts a number on the way out and reads it back as a `Date` either way —
 * this just stops the two spellings existing.
 *
 * `matchedCount` and a 404, not `modifiedCount` and a 500: a closure that matched nothing is an id the
 * admin no longer has — a stale row in a table open in another tab — and telling them the server broke
 * would not be true.
 */
export async function funUserDelete(_id: Types.ObjectId, adminId: Types.ObjectId) {
	const ret = await User.updateOne(
		{ _id: _id, deleted: trusted({ $exists: false }) },
		{ $set: { deleted: new Date(), deletedBy: adminId } }
	).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('user not found')
}
