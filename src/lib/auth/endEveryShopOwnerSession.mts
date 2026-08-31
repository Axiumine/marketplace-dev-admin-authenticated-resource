import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { Types } from 'mongoose'

/**
 * Ends every session a **shop owner** holds, called by an admin's write to that shop owner's account.
 * Called after the Mongo write has landed, never before it.
 *
 * ⚠️ **This is the cross-account revoke, and it is the mirror image of `endEverySession`.** There the
 * account being torn down is the caller's own; here the caller is an Admin and the account is somebody
 * else's, so two things flip. The admin's own session is untouched — they have done nothing to their
 * own credentials and logging them out mid-page would make the console unusable. And there is no access
 * key to delete: `deleteSession` needs the token, the admin does not have the shop owner's, and no
 * index files access keys. `endEverySession`'s "the caller goes too" rule does not apply and is not being relaxed —
 * it is a rule about *whose* credentials changed, and the answer here is not the caller's.
 *
 * ⚠️ **There is no residual, and this comment claimed one until 2026-08-25.** It was written before R54
 * and described the routine as it then was: refresh sessions revoked, an access token already in the shop
 * owner's hands left working until it expired on its own. Since R54 `revokeAllSessionsForAccount` retires
 * **both halves of every session**, reading each `accessKey` out of the session hash before it deletes it,
 * so the device the shop owner is signed in on stops working on this call. No access-token deny list is
 * needed for that, and none was built: the index reaches the access half through the refresh half it
 * already names.
 *
 * `TIER.shopOwner`, and the tier is not incidental: the index key is per tier, so the wrong constant
 * reads an index belonging to an admin with the same `_id` — none exists, so the revoke would delete
 * nothing and report success.
 */
export async function endEveryShopOwnerSession(idShopOwner: Types.ObjectId | string) {
	await revokeAllSessionsForAccount({ store: redisClient, tier: TIER.shopOwner, accountId: `${idShopOwner}` })
}
