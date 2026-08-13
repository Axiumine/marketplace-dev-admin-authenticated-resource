import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { sessionIndexKey, sessionKeyFromIndexField } from '@axiumine/marketplace-common/others/sessionKeys'
import { Tier } from '@axiumine/marketplace-common/others/Tier'
import { guardSessionWrite } from '@lib/session/guardSessionWrite.mjs'
import { Types } from 'mongoose'

/**
 * Ends one session and stops it being listed (E17-S03).
 *
 * ⚠️ **Both commands run, always, and the index field is pruned even when the session was already gone.**
 * An index row outliving its session is the defect this function exists to prevent: the row would sit on
 * the operator's screen naming a session that cannot be ended, and every attempt would answer success
 * having deleted nothing. Revoking a dead session is therefore not an error — it is the case that repairs
 * the list, and it answers `false` so the console can say "already ended" rather than "ended".
 *
 * ⚠️ **The session key first, its index field second.** A process death between the two leaves a row naming
 * a key that no longer exists, which the next call cleans up and which grants nobody anything. The reverse
 * order leaves a live session listed nowhere — invisible to the operator and to E15-S04's revocation, alive
 * until its own cap. That asymmetry is the same one `revokeAllSessionsForAccount` is built on.
 *
 * ⚠️ **One single-key `del`** (BCON-08), and one `hDel` on the account's own index key. Nothing here scans,
 * and nothing here needs the token: the field *is* the body of the key to delete, which is what
 * `sessionKeyFromIndexField` exists for.
 *
 * ⚠️ **The access token minted from this refresh session keeps working until its own expiry** — minutes.
 * Only refresh sessions are indexed (`indexSession`), so this is the same residual the `disabled` flag has
 * always carried. An operator who needs it gone sooner is asking for an access-token deny list, which this
 * platform has deliberately not built.
 */
export async function funRevokeSession(_id: Types.ObjectId, tier: Tier, accountId: string, sessionId: string): Promise<boolean> {
	await guardSessionWrite('revoke', _id.toString())

	const deleted = await redisClient.del(sessionKeyFromIndexField(sessionId))

	await redisClient.hDel(sessionIndexKey(tier, accountId), sessionId)

	return deleted === 1
}
