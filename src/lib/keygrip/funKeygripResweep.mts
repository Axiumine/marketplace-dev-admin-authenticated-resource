import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { sha256Hex } from '@axiumine/marketplace-common/others/sha256Hex'
import { endEveryPlatformSession, ISweepOutcome } from '@lib/keygrip/endEveryPlatformSession.mjs'
import { guardKeygripWrite } from '@lib/keygrip/guardKeygripWrite.mjs'
import * as Sentry from '@sentry/node'
import { Types } from 'mongoose'

/**
 * Runs the platform-wide session sweep again, on its own, after a retirement left part of it undone
 * (R55, ADR-034).
 *
 * ⚠️ **This exists because `keygripRetire` cannot be retried.** The retirement takes the key out of the
 * record before it sweeps, so the second attempt at that mutation answers 404 — correctly, since nothing
 * would be retired — and the admin holding a half-swept platform had nowhere to go but a console. The
 * sweep is the half that is safe to repeat, so it is the half that gets its own button.
 *
 * ⚠️ **It touches the keygrip record not at all: no read, no KEK, no compare-and-set.** There is nothing
 * left to write — the key is already gone from the key set, which is what makes the retirement's 404
 * right — so this operation cannot answer 404 or 409 and cannot lose a race with a rotation running
 * beside it. What it does is walk accounts and delete sessions, and the worst a concurrent rotation costs
 * is a handful of sessions minted a second before they were ended.
 *
 * ⚠️ **Safe to run at any time, and safe to run twice.** `revokeAllSessionsForAccount` deletes each
 * account's index key last, so an interrupted account is an index naming keys that are already gone and a
 * second pass over it deletes nothing and counts nothing. The cost of an unnecessary run is that everyone
 * signs in again — which is the cost the admin already accepted by pressing retire, and the reason the
 * mutation's description says so out loud rather than presenting this as a repair with no downside.
 *
 * ⚠️ **Metered in its own bucket** (`guardKeygripWrite`'s rule): this is the write an admin reaches for
 * while a compromise is live, and an afternoon of rotations must not have spent its allowance.
 *
 * Two failures, both 500: the sweep could not start at all, or it ran and some accounts' revokes threw.
 * Both say run it again, because both are finished by exactly that.
 */
export async function funKeygripResweep(_id: Types.ObjectId): Promise<void> {
	await guardKeygripWrite('resweep', _id.toString())

	let sweep: ISweepOutcome

	try {
		sweep = await endEveryPlatformSession()
	} catch (e) {
		throwInternalError(
			`The session sweep could not start: ${(e as Error).message}. No session was ended. Run keygripResweep again once the platform's data stores answer.`
		)
	}

	/*
	 * The audit trail, written before the partial-failure refusal for `funKeygripRetire`'s reason: sessions
	 * were ended and that is worth a line whether or not the rest of the walk got through.
	 *
	 * ⚠️ **The admin is named by digest and the accounts are not named at all.** This becomes an
	 * `event.message`, which `sentryBeforeSend` does not walk, so anything written here reaches the vendor
	 * verbatim — the same decision `funKeygripRotate` and `funKeygripRetire` record on their own audit lines.
	 */
	Sentry.captureMessage(
		`keygrip session resweep by admin ${sha256Hex(_id.toString())}, ending ${sweep.ended} sessions across ${sweep.failed} unreached accounts`,
		'info'
	)

	if (sweep.failed > 0)
		throwInternalError(
			`The resweep ended ${sweep.ended} sessions, but ${sweep.failed} accounts could not be reached and may still hold live ones: ${sweep.reason}. Run keygripResweep again — it walks every account and is safe to repeat.`
		)
}
