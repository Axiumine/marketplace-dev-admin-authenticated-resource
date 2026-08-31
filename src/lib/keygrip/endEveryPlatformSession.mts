import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { Admin } from '@axiumine/marketplace-common/models/MongoDB/Admin'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { TIER, Tier } from '@axiumine/marketplace-common/others/Tier'
import { Types } from 'mongoose'

/**
 * The one thing this sweep needs a model to do, expressed structurally rather than as `Model<TAccount>`.
 *
 * `Model<T>` is **invariant** in `T` and the three account documents are unrelated types, so a function
 * typed against it would take none of the three collections without a cast per call site — the same
 * reason `IScrubbableAccountModel` and `marketplace-common`'s `ISessionAccountModel` are written this
 * way. `PromiseLike`, not `Promise`: mongoose hands back a `Query`, a thenable with no
 * `[Symbol.toStringTag]`.
 */
export interface IAccountIdModel {
	find(filter: object, projection: string): { lean(): PromiseLike<{ _id: Types.ObjectId }[]> }
}

/**
 * What one sweep did, rather than only how much of it worked.
 *
 * ⚠️ **`failed` is a count and never a list of account ids** (R55). The remedy does not need them — a
 * resweep walks every account rather than a list — and an id here would travel into an error message
 * that `throwInternalError` reports to Sentry, where `funKeygripRetire` already refuses to name the
 * admin for the same reason: these three collections hold people.
 *
 * ⚠️ **`reason` is the first failure's message and the rest are dropped.** A sweep that fails usually
 * fails for one reason, and a thousand copies of `Redis connection lost` is not a better answer than
 * one. Empty when nothing failed, so a caller reads `failed` and never the string.
 */
export interface ISweepOutcome {
	ended: number
	failed: number
	reason: string
}

/**
 * Ends every session held by every account of one tier, and answers how many it ended.
 *
 * ⚠️ **The routine is `revokeAllSessionsForAccount`, imported and not re-implemented** — the fourth call
 * site on this service, and the rule `funRevokeAllSessions` states applies unchanged: a hand-written
 * revoke loop here would be another chance to get the command order wrong in a way that fails open, on
 * the one path an admin reaches while a key is believed to be in someone else's hands.
 *
 * ⚠️ **Account by account, because the session keyspace can only be read that way.** BCON-08 bans `SCAN`
 * and `KEYS`, and there is no set of live sessions to walk: one account's sessions are one index hash
 * (`idx:<tier>:<accountId>`), reachable only from an id Mongo holds. So the ids come from the collection
 * and the revoke is per account — a round trip each, on a mutation that runs during an incident and
 * nowhere else.
 *
 * ⚠️ **The projection is `_id` and must stay that.** These three collections carry encrypted personal
 * data (ADR-029), and a wider projection would pull every customer's decrypted document through this
 * process to read a field it never uses.
 *
 * ⚠️ **One account's failure ends that account's revoke and nothing else** (R55). A
 * `revokeAllSessionsForAccount` that threw used to take the rest of this tier — and every tier after it —
 * with it, so one unlucky round trip could leave most of the platform holding the sessions a retirement
 * was meant to end. The throw is counted instead and the walk goes on, because a sweep that reaches every
 * account it can is strictly better than one that stops at the first it cannot, and because what is left
 * is finished by running the sweep again: `revokeAllSessionsForAccount` deletes the index key last, so an
 * interrupted account is at worst an index naming keys that are already gone, and re-running it is safe.
 */
export async function endEveryTierSession(model: IAccountIdModel, tier: Tier): Promise<ISweepOutcome> {
	const accounts = await model.find({}, '_id').lean()

	let ended = 0
	let failed = 0
	let reason = ''

	for (const account of accounts)
		try {
			ended += await revokeAllSessionsForAccount({ store: redisClient, tier, accountId: account._id.toHexString() })
		} catch (e) {
			failed++

			if (!reason) reason = (e as Error).message
		}

	return { ended, failed, reason }
}

/**
 * Logs the whole platform out — every admin, every shop owner, every customer — and answers how many
 * sessions that was. Called by `funKeygripRetire` once the retirement has been written, and by nothing
 * else (ADR-034, R47).
 *
 * ⚠️ **This exists because a retired key keeps verifying on a service that has not adopted the new record
 * yet.** Adoption is a poll plus a pub/sub nudge, measured at 8 ms and bounded at `KEYGRIP_POLL_MS` if
 * the nudge is lost, and during that window a holder still carrying the retired key verifies a cookie the
 * retirement was meant to kill. Ending the sessions closes it from the other side: the lagging holder
 * verifies the signature, looks the session up, finds nothing, and answers 498. The window stops
 * mattering rather than being made smaller — which is what R47 asked for and what tuning the poll could
 * never give.
 *
 * ⚠️ **No account is exempt, the retiring admin included.** They are logged out by their own retirement
 * and have to sign in again, which is the cost of the rule having no hole in it: an exemption is granted
 * to *whichever session sent the mutation*, and someone holding a stolen admin cookie can send it — the
 * reasoning `endEverySession` records, on the tier where it matters most.
 *
 * ⚠️ **Blunt on purpose: it ends sessions the retired key never signed.** Nothing in Redis records which
 * key signed which cookie — the session hash holds no key id, and adding one would put a key's name
 * beside every session on the platform. So the sweep ends all of them, and a few thousand people sign in
 * again because one key was suspected. That is the trade an admin is making when they press retire, and
 * the mutation's description says so.
 *
 * ⚠️ **A sweep that could not reach every account answers rather than throws** (R55). What propagates out
 * of here is a tier that could not be read at all — the `find` is outside the per-account catch — and what
 * is reported is the count of accounts whose revoke threw, so a caller can tell "the sweep never ran" from
 * "the sweep ran and left N accounts standing". Both are a 500 to the admin; only the second one is
 * finished by `funKeygripResweep` rather than by waiting for Redis to answer at all.
 *
 * The three tiers run in sequence rather than in parallel, for `retentionSweep`'s reason: there is nothing
 * to win by bursting this service's connection pools, and an incident response is not a latency budget.
 */
export async function endEveryPlatformSession(): Promise<ISweepOutcome> {
	const admins = await endEveryTierSession(Admin, TIER.admin)
	const shopOwners = await endEveryTierSession(ShopOwner, TIER.shopOwner)
	const users = await endEveryTierSession(User, TIER.user)

	return {
		ended: admins.ended + shopOwners.ended + users.ended,
		failed: admins.failed + shopOwners.failed + users.failed,
		reason: admins.reason || shopOwners.reason || users.reason
	}
}
