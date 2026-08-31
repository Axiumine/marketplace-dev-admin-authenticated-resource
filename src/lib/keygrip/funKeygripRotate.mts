import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwConflictError } from '@axiumine/koa-utils/graphQL/throw/throwConflictError'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { rotateKeygripKeys } from '@axiumine/marketplace-common/encryption/rotateKeygripKeys'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { readKek } from '@axiumine/marketplace-common/others/readKek'
import { IKeygripRecord, readKeygrip } from '@axiumine/marketplace-common/others/readKeygrip'
import { sha256Hex } from '@axiumine/marketplace-common/others/sha256Hex'
import { guardKeygripWrite } from '@lib/keygrip/guardKeygripWrite.mjs'
import { keygripCasWrite } from '@lib/keygrip/keygripCas.mjs'
import * as Sentry from '@sentry/node'
import { Types } from 'mongoose'

/**
 * Rotates the fleet's cookie-signing keys, without restarting anything (ADR-034).
 *
 * ⚠️ **This and `funKeygripRetire` are the only writers of the keygrip record on the platform** — the five
 * signing services read it and never write it, and the seed script runs once, before any of them exist.
 *
 * ⚠️ **No key material leaves this function.** Not to the caller, not to a log, not to Sentry. The
 * mutation answers `Boolean!` rather than the new key set for exactly that reason, and the audit event
 * below carries the admin's id, the new version and the fingerprint of the key *ids* — which is
 * public by construction, see `keygripFingerprint`. An admin who could read the material back would
 * be able to mint a session cookie for any account on the platform, which is a strictly larger power
 * than the one this mutation exists to grant.
 *
 * The four refusals, and what each asks of the admin:
 *
 * - too many writes this hour — `guardKeygripWrite`, a 429 before anything is read.
 * - the record cannot be read or opened — `readKeygrip`'s own two, reported as 500s. Nothing was
 *   written, and this service's `KEYGRIP_KEK` is either wrong or the record is gone.
 * - the key set is full and nothing in it has aged out — `rotateKeygripKeys`' cap, reported as a 409
 *   carrying the wait. Retiring a key that is still verifying cookies would log those customers out.
 * - somebody rotated first — the compare failed, reported as a 409. Retry: the second rotation is
 *   built on the first one's record.
 */
export async function funKeygripRotate(_id: Types.ObjectId): Promise<void> {
	// Before the read, so a runaway client is refused for the price of one INCR rather than an unwrap.
	await guardKeygripWrite('rotate', _id.toString())

	// Reads and unwraps, or throws. Deliberately not `loadKeygrip`: that one announces its caller in the
	// holders table, and this service holds the KEK to reseal the record, never to sign a cookie — a row
	// here would be a permanently stale entry in the table `keygripStatus` reads to find stale entries.
	let record: IKeygripRecord
	try {
		record = await readKeygrip(redisClient)
	} catch (e) {
		// The message names a version and a fingerprint and nothing else, and it is the only thing that
		// tells an admin whether to fix this service's env or to re-seed the fleet.
		throwInternalError((e as Error).message)
	}

	// The one decode site on the platform (ADR-040). `readKeygrip` has already proved this variable is
	// present and exactly 32 bytes — an unwrap that succeeded is a stronger check than the length check
	// `readKek` repeats — so what this call buys is not a guard but a single place an adopter has to change
	// when the KEK stops coming from `process.env`. A private `Buffer.from` here is a regression.
	const kek = readKek()

	// The key-lifecycle rules — mint, prepend, retire what stopped signing longer ago than the longest
	// session this platform issues, never fall below two, refuse rather than trim — are one shared
	// function, so the admin panel and any future automation cannot disagree about them. Its only failure
	// is the cap.
	let keys: IKeygripKeyMaterial[]
	try {
		keys = rotateKeygripKeys(record.keys, new Date())
	} catch (e) {
		throwConflictError((e as Error).message)
	}

	const { written, version } = await keygripCasWrite(record.version, keys, kek)

	if (!written)
		throwConflictError(
			'The keygrip record changed while this rotation was being prepared, so nothing was written. Another admin rotated a moment ago — reload the page and rotate again if you still need to.'
		)

	/*
	 * The audit trail, and the only record that this happened at all. Rotating the signing keys is the
	 * most powerful thing an admin can do to sessions on this platform, and it leaves no document
	 * behind — the record it writes holds no author. `captureMessage` at info level is what the boot
	 * banner already uses; a missing DSN makes it inert rather than fatal.
	 *
	 * ⚠️ **The admin is named by digest, never by id.** This message becomes
	 * `event.message`, and `sentryBeforeSend` walks `event.request`, `event.user`, `contexts.trace.data`
	 * and the breadcrumbs — never the top-level message — so whatever is written here leaves the host
	 * verbatim. The digest keeps the trail attributable to whoever holds the `admin` collection, which is
	 * the only party that ever needs to resolve it, and hands the vendor a string that names nobody. It is
	 * the same handling `assertUnderRateLimit` already gives this exact value, and `sha256Hex` states the
	 * limit of it: this is pseudonymisation, and an id space this small is enumerable by anyone who
	 * already holds the collection. That is the intended reader, not the threat.
	 */
	Sentry.captureMessage(
		`keygrip rotated to version ${version} (${keygripFingerprint(keys)}) by admin ${sha256Hex(_id.toString())}`,
		'info'
	)
}
