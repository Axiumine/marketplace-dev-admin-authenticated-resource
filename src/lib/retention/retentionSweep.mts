import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { buildAccountScrub, IAccountScrub, ScrubbableTier } from '@axiumine/marketplace-common/others/accountScrub'
import { MILLISECONDS_PER_DAY } from '@axiumine/marketplace-common/others/sessionLifetime'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { trusted, Types } from 'mongoose'

/**
 * How long a closed account keeps everything it holds.
 *
 * ⚠️ **This number is a promise made in two places at once, and moving it here alone breaks the other.**
 * ADR-046 makes the retention period an *undo* window: for these thirty days the address is still spoken
 * for by the closed document, and registering again at it hands the account back. Shorten this and an undo
 * that the privacy page promises stops working; lengthen it and the platform holds personal data longer
 * than it told anybody it would. The frontend copy in `marketplace-user`'s privacy page states the same
 * figure.
 */
export const RETENTION_DAYS = 30

/**
 * The instant a closure has to be older than for its account to be scrubbed.
 *
 * Takes `now` rather than reading the clock, because the sweep stamps `scrubbedAt` with the same instant
 * it selects against: a function that read `Date.now()` twice could select a document under one clock and
 * stamp it under another, and no test could pin either.
 */
export const retentionCutoff = (now: Date): Date => new Date(now.getTime() - RETENTION_DAYS * MILLISECONDS_PER_DAY)

/**
 * The only filter that may ever select a document for scrubbing (ADR-041).
 *
 * ⚠️ **Both `trusted()` calls are load-bearing and their absence is silent.** `sanitizeFilter` is on
 * process-wide, so an unwrapped `$`-keyed value is rewritten to `{ $eq: { $lte: … } }` — a filter that
 * matches nothing, for ever, while every run reports success. A sweeper that no-ops looks exactly like a
 * sweeper with nothing to do, which is why ADR-041 requires the proof to be an integration test against a
 * real collection rather than an assertion on this object.
 *
 * ⚠️ **Two clauses, and a third is a mass overwrite with no undo.** `deleted` older than the cutoff is
 * *which* accounts, and the absence of `scrubbedAt` is *not yet done*; anything else added here widens a
 * destructive write over documents nobody decided to erase. The filter lives in its own function for that
 * reason — one place to read, one place to test.
 *
 * Both paths are deliberately outside `ENCRYPTED_FIELDS_*` (ADR-029): the comparison is server-side, and
 * a deterministic ciphertext answers equality only — never `$lte` — while a random one answers nothing.
 */
export const scrubCandidates = (cutoff: Date) => ({
	deleted: trusted({ $lte: cutoff }),
	scrubbedAt: trusted({ $exists: false })
})

/** What the sweep reads back per candidate: who to scrub, and which half of the reason rule applies. */
export interface IScrubCandidate {
	_id: Types.ObjectId
	disabled?: boolean
}

/**
 * The two things the sweep needs a model to do, expressed structurally rather than as `Model<TAccount>`.
 *
 * `Model<T>` is **invariant** in `T` and the two document types are unrelated, so one function typed
 * against it would take neither collection without a cast per call site — the same reason
 * `ISessionAccountModel` in `marketplace-common` is written this way. `PromiseLike`, not `Promise`:
 * mongoose hands back a `Query`, a thenable with no `[Symbol.toStringTag]`.
 */
export interface IScrubbableAccountModel {
	find(filter: object, projection: string): { lean(): PromiseLike<IScrubCandidate[]> }
	updateOne(filter: { _id: Types.ObjectId }, update: IAccountScrub): { exec(): PromiseLike<unknown> }
}

/**
 * Scrubs every account of one tier whose retention window has run out, and answers how many it wrote.
 *
 * ⚠️ **One update per document, not one `updateMany`.** The scrubbed address is `deleted-<_id>@invalid.local`
 * — derived from the document being written — and `login.email_unique` carries no `sparse` and no partial
 * filter (ADR-011), so a single constant address across two documents is an `E11000` at the moment of
 * erasure. Per-document is what makes the placeholder unique.
 *
 * ⚠️ **Through Mongoose, never `Model.collection`.** `fieldEncryptionPlugin` rewrites `$set` operands on
 * the way past, including the whole-object `$set` on `personalData`; a driver-level write would put readable
 * personal data into `binData` paths and be refused by the collection validator, at best.
 *
 * ⚠️ **`disabled` is read here and handed on** — `buildAccountScrub`'s fourth argument picks between
 * overwriting `disabledReason` and removing it, and the validator's `dependencies: { disabled:
 * ['disabledReason'] }` refuses the removal on a document that stays suspended. That is the whole reason
 * the projection is `_id disabled` rather than `_id`. `disabled === true` rather than a truthiness test:
 * the path is optional, so a document that was never parked reads back `undefined`.
 *
 * No transaction. Each document is scrubbed independently and the stamp is part of the same update, so a
 * crash mid-sweep leaves some accounts scrubbed and the rest still selected by the next run — which is the
 * behaviour wanted. Wrapping the batch would make one failed document undo everybody else's erasure.
 */
export async function sweepTier(model: IScrubbableAccountModel, tier: ScrubbableTier, now: Date, cutoff: Date): Promise<number> {
	const candidates = await model.find(scrubCandidates(cutoff), '_id disabled').lean()

	for (const candidate of candidates) {
		await model
			.updateOne({ _id: candidate._id }, buildAccountScrub(tier, candidate._id.toHexString(), now, candidate.disabled === true))
			.exec()
	}

	return candidates.length
}

/**
 * One pass over both scrubbable collections, answering what it wrote.
 *
 * `admin` is not swept and has no lifecycle paths to sweep: admins are seeded rather than registered,
 * and nobody has decided what closing one means (`ScrubbableTier` records the same).
 *
 * The two tiers run in sequence rather than in parallel, on purpose: this is a background job on the
 * admin service's own connection pool, and there is nothing to win by making it burst.
 */
export async function retentionSweep(now: Date): Promise<{ shopOwner: number; user: number }> {
	const cutoff = retentionCutoff(now)

	return {
		shopOwner: await sweepTier(ShopOwner, TIER.shopOwner, now, cutoff),
		user: await sweepTier(User, TIER.user, now, cutoff)
	}
}
