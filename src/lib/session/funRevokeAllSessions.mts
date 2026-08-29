import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { Tier } from '@axiumine/marketplace-common/others/Tier'
import { guardSessionWrite } from '@lib/session/guardSessionWrite.mjs'
import { Types } from 'mongoose'

/**
 * Ends every session one account holds, from the admin's console (E17-S03), and answers how many there
 * were so the console can say what it just did rather than "done".
 *
 * ⚠️ **The routine is E15-S04's, imported and not re-implemented.** It is the same code a password change,
 * a disable and a status change revoke through, including E17-S04's re-read of the index before the key is
 * deleted — the correction that stops a login landing mid-revoke from becoming an invisible session. A
 * hand-written revoke loop here would be a fourth chance to get the command order subtly wrong in a way
 * that fails open, on the one path where an admin has been told the account is closed.
 *
 * ⚠️ **The account is named by tier *and* id, both.** Ids come from three separate collections and nothing
 * stops two of them minting the same `ObjectId` string, so a revocation by id alone could end a stranger's
 * sessions — which on this path means an admin investigating one account logging out another.
 *
 * ⚠️ **This ends the admin's own sessions when they name their own account.** That is not guarded
 * against: the console is a tool for ending sessions, and a rule exempting the caller is a rule an attacker
 * holding the caller's session can aim at — the same reasoning `endEverySession` records for E15-S05.
 */
export async function funRevokeAllSessions(_id: Types.ObjectId, tier: Tier, accountId: string): Promise<number> {
	await guardSessionWrite('revokeAll', _id.toString())

	return revokeAllSessionsForAccount({ store: redisClient, tier, accountId })
}
