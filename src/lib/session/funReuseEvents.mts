import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IReuseEvent, REUSE_EVENTS_MAX } from '@axiumine/marketplace-common/others/recordReuseEvent'
import { reuseEventsKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { Tier } from '@axiumine/marketplace-common/others/Tier'

/**
 * Reads one account's reuse trail — what was revoked, when, and why (E17-S05).
 *
 * ⚠️ **`lRange` over one key, newest first** (BCON-08). `recordReuseEvent` appends with `lPush`, so index 0
 * is the most recent event and the range is read in storage order rather than sorted here; the trail is
 * already bounded to `REUSE_EVENTS_MAX` by the trim on every append, and asking for exactly that many is
 * how a list that somehow grew past its bound still answers in bounded time instead of paging a surprise
 * into the console.
 *
 * ⚠️ **Nothing in a line is a credential, and that is the store's contract rather than this reader's**
 * filter — see `IReuseEvent`, where the omission of any token, digest, prefix or network value is written
 * down. This function does not strip anything, because nothing that would need stripping is ever written.
 *
 * ⚠️ **The lines are parsed without a guard, deliberately.** The list has exactly one writer, which appends
 * `JSON.stringify` output through a single atomic `lPush`, so a half-written line is not a state Redis can
 * be in. A `try`/`catch` here would be an untestable branch pretending otherwise, and would hide a genuine
 * corruption behind a silently shorter list.
 *
 * A missing key answers an empty array: an account that has never had a lineage revoked has no trail, which
 * is the ordinary case and renders as an empty table rather than as an error.
 */
export async function funReuseEvents(tier: Tier, accountId: string): Promise<IReuseEvent[]> {
	const lines = await redisClient.lRange(reuseEventsKey(tier, accountId), 0, REUSE_EVENTS_MAX - 1)

	return lines.map((line) => JSON.parse(line) as IReuseEvent)
}
