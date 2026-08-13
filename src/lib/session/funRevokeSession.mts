import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { retireAccessSession, sessionIndexKey, sessionKeyFromIndexField } from '@axiumine/marketplace-common/others/sessionKeys'
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
 * ⚠️ **The access token this refresh session minted goes with it, and goes first** (R54, 2026-08-13). Only
 * refresh sessions are indexed (`indexSession`), so the row the operator clicked names one half of a pair;
 * the other is named by the `accessKey` field inside the hash about to be deleted, which is why
 * `retireAccessSession` runs before the `del` rather than after it. Until it did, ending a session left the
 * account holding a working bearer token for up to 91 minutes — the surprise the console's own text used
 * to have to warn about. No deny list was needed for this and none was built: the session records the key
 * of its own access half, so ending it is one read and one delete.
 *
 * ⚠️ **A session that carries no bound key is still ended.** A hash minted before the field existed, and one
 * that expired between the operator's read and their click, both answer `null` — the pre-2026-08-13
 * behaviour, which is the floor here and never the result of a failed read.
 */
export async function funRevokeSession(_id: Types.ObjectId, tier: Tier, accountId: string, sessionId: string): Promise<boolean> {
	await guardSessionWrite('revoke', _id.toString())

	const sessionKey = sessionKeyFromIndexField(sessionId)

	await retireAccessSession(redisClient, sessionKey)

	const deleted = await redisClient.del(sessionKey)

	await redisClient.hDel(sessionIndexKey(tier, accountId), sessionId)

	return deleted === 1
}
