import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import { sessionIndexKey, sessionKeyFromIndexField } from '@axiumine/marketplace-common/others/sessionKeys'
import { Tier } from '@axiumine/marketplace-common/others/Tier'

/**
 * One live session, as an admin needs to see it (E17-S02).
 *
 * ⚠️ **`id` is the session index field: the SHA-256 of the prefixed refresh token, never the token.** It is
 * safe to put on a screen and it is safe to accept back from one, and neither is obvious, so both are
 * written down here.
 *
 * *Safe to show*, because a digest of a 128-bit random value is not invertible and because no code path
 * anywhere accepts a bare digest as a credential: every reader hashes the **prefixed** token — `access:…`
 * or `refresh:…` — before it names a key, so a bare digest handed back matches nothing. The prefix is what
 * stops a row id being replayed as the token it names, which is precisely why `hashSessionToken` insists
 * on hashing the prefixed value.
 *
 * *Safe to take back*, because `revokeSession` uses it only to name a Redis key and a hash field of an
 * account the caller has already named. It authenticates nothing.
 *
 * ⚠️ **Nothing here is network- or device-derived** — no address, not truncated, not hashed, not salted.
 * That is the standing decision this platform has taken on session rows (E17 §2), and the reason the row
 * is assembled from the session hash rather than from anything the request carried.
 */
export interface ISessionRow {
	id: string
	tier: Tier
	mintedAt: string
	familyId: string
}

/**
 * Lists the sessions one account holds (E17-S02).
 *
 * ⚠️ **The index is read with `hGetAll` on one key — never `SCAN`, never `KEYS`** (BCON-08). One account's
 * sessions are one hash: one key, one round trip, one slot on a cluster. This is the whole reason E15-S02
 * built the index in the first place, and a console that scanned would be the thing it was built to avoid.
 *
 * ⚠️ **Every field of every row comes from the session hash, not from the index entry.** The index value
 * carries its own copy of the tier and the mint time (`ISessionIndexEntry`), and reading it here would give
 * a row assembled from two records that a failed rotation could leave disagreeing. The session hash is the
 * record the platform actually authenticates against, so it is the one an admin deciding what to end
 * should be looking at. The index answers one question only: *which* sessions exist.
 *
 * ⚠️ **A field naming a session that is already gone is dropped, not rendered.** Rotation and logout prune
 * their own field and E15-S03 gives every field a TTL, but a session whose key expired between that TTL and
 * this read is a real state and it must not be listed as live — an admin ending a session that ended
 * itself would read the no-op as "it did not work". `hGetAll` on a missing key answers `{}`, which is the
 * whole test. The stale field is left in place rather than pruned here: this is a read, and a read that
 * writes is a read that needs a rate limit and an audit line of its own.
 *
 * Rows come back sorted newest login first, with the id as tie-break, because Redis returns hash fields in
 * whatever order the keyspace holds them — stable for nobody, and a table that reshuffles between polls is
 * a table an admin cannot click safely.
 */
export async function funSessions(tier: Tier, accountId: string): Promise<ISessionRow[]> {
	const fields = Object.keys((await redisClient.hGetAll(sessionIndexKey(tier, accountId))) as Record<string, string>)

	const rows = await Promise.all(
		fields.map(async (field) => {
			const session = (await redisClient.hGetAll(sessionKeyFromIndexField(field))) as unknown as Partial<IRefreshData>

			return typeof session.familyId === 'undefined'
				? undefined
				: { id: field, tier: session.tier as Tier, mintedAt: session.originalLogin as string, familyId: session.familyId }
		})
	)

	return rows
		.filter((row): row is ISessionRow => typeof row !== 'undefined')
		.sort((a, b) => Number(b.mintedAt) - Number(a.mintedAt) || a.id.localeCompare(b.id))
}
