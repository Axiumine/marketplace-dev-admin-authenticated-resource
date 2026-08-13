import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { Types } from 'mongoose'

/**
 * Ends every session a **shop owner** holds, called by an operator's write to that shop owner's account
 * (E15-S06, and E15-S07 next). Called after the Mongo write has landed, never before it.
 *
 * ⚠️ **This is the cross-account revoke, and it is the mirror image of `endEverySession`.** There the
 * account being torn down is the caller's own; here the caller is an Admin and the account is somebody
 * else's, so two things flip. The operator's own session is untouched — they have done nothing to their
 * own credentials and logging them out mid-page would make the console unusable. And there is no access
 * key to delete: `deleteSession` needs the token, the operator does not have the shop owner's, and no
 * index files access keys. E15-S05's "the caller goes too" rule does not apply and is not being relaxed —
 * it is a rule about *whose* credentials changed, and the answer here is not the caller's.
 *
 * ⚠️ **The residual is one access-token lifetime, same as the `disabled` flag has always carried.** The
 * shop owner's refresh sessions die here, so nothing new can be minted, but an access token already in
 * their hands keeps working until it expires on its own. Closing that gap needs an access-token deny
 * list, which this platform has deliberately not built.
 *
 * `TIER.shopOwner`, and the tier is not incidental: the index key is per tier, so the wrong constant
 * reads an index belonging to an operator with the same `_id` — none exists, so the revoke would delete
 * nothing and report success.
 */
export async function endEveryShopOwnerSession(idShopOwner: Types.ObjectId | string) {
	await revokeAllSessionsForAccount({ store: redisClient, tier: TIER.shopOwner, accountId: `${idShopOwner}` })
}
