import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { unpublishOwnerStorefront } from '@lib/shopOwner/unpublishOwnerStorefront.mjs'
import mongoose, { trusted, Types } from 'mongoose'

/**
 * Closes a shop owner's account: a stamp, never a removal, and the whole storefront goes dark with it.
 *
 * ⚠️ **`deletedBy` is what says an operator did this** (ADR-044). The field is an `admin._id` and its
 * *absence* beside a `deleted` stamp is the record that the account holder closed it themselves — which is
 * why nothing here writes a collection name alongside the id. There is exactly one possible actor
 * collection per stamp, so the field's own name carries it; a second field saying which would be a `role`
 * field arriving by the back door, and ADR-002 refuses that.
 *
 * ⚠️ **The filter refuses an account that is already closed, and that is a retention rule rather than
 * tidiness.** `deleted` starts the thirty-day clock ADR-041 measures and ADR-046 makes an undo window, so
 * a second closure over the same document would push the scrub thirty days further out and postpone the
 * erasure the first one promised. Matching nothing here answers 404 — the account is gone as far as this
 * mutation is concerned — instead of silently resetting the clock. `trusted()` is not optional:
 * `sanitizeFilter` is global and strips a bare `$exists`.
 *
 * ⚠️ **The storefront cascade shares this transaction** (ADR-045). A crash between the stamp and the
 * `published: false` writes leaves a closed owner with a live shop, which is the one failure that decision
 * exists to prevent. Nothing ever puts either back automatically: an owner who returns through the
 * registration undo keeps their `_id` and therefore still owns every company and item, all of them dark
 * and all of them theirs to republish by hand.
 *
 * `waitApprov` is dropped so a closed account cannot sit in the approval queue. It comes back up by itself
 * if the owner ever returns — the restore in `confirmRegistration` re-raises it, so an operator who closed
 * a seller for cause can simply decline to approve them a second time.
 *
 * `new Date()`, not `Date.now()`: the retention sweep compares `deleted` against a cutoff, and the model's
 * path is a `Date`. A number would be cast on the way out and read back as one either way — this just
 * stops the two spellings existing.
 *
 * `matchedCount` and a 404, not `modifiedCount` and a 500, which is what this used to answer. A closure
 * that matched nothing is an id the operator no longer has, and telling them the server broke was never
 * true.
 */
export async function funShopOwnerDelete(_id: Types.ObjectId, adminId: Types.ObjectId) {
	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			const ret = await ShopOwner.updateOne(
				{ _id: _id, deleted: trusted({ $exists: false }) },
				{
					$set: { deleted: new Date(), deletedBy: adminId },
					$unset: { waitApprov: 1 }
				}
			)
				.session(session)
				.exec()

			if (ret.matchedCount !== 1) throwNotFoundError('shopOwner not found')

			await unpublishOwnerStorefront(_id, session)
		})
	} finally {
		await session.endSession()
	}
}
