import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { Types } from 'mongoose'

/**
 * Ends every session a **customer** holds, called by an operator's write to that customer's account
 * (E19-S03). Called after the Mongo write has landed, never before it.
 *
 * The third call site of `revokeAllSessionsForAccount` on this service and the second cross-account one:
 * the operator's own session is untouched — E15-S05's "the caller goes too" is a rule about whose
 * credentials changed, and these are not the caller's — and no access key is deleted by name here, because
 * the operator does not hold the customer's token.
 *
 * ⚠️ **There is no residual, and the older comment on `endEveryShopOwnerSession` still says there is.**
 * Since R54 the routine retires **both halves of every session**, reading each `accessKey` out of the
 * session hash before it deletes it, so the device the customer is signed in on stops working on this call
 * rather than at the end of an access token's own life. A suspension is therefore immediate, and the
 * mutation may say so.
 *
 * ⚠️ **`TIER.user`, and on this call the tier is the trap rather than a detail.** All nine services share
 * one `REDIS_KEY` prefix and the index key is per tier, so `TIER.shopOwner` with a customer's `_id` reads
 * the index of a shop owner who does not exist: `hKeys` answers an empty array, nothing is deleted, no
 * error is raised, and the mutation reports the customer signed out while every session they hold is still
 * live. The wrong constant here fails silently and in the safe-looking direction.
 */
export async function endEveryUserSession(idUser: Types.ObjectId | string) {
	await revokeAllSessionsForAccount({ store: redisClient, tier: TIER.user, accountId: `${idUser}` })
}
