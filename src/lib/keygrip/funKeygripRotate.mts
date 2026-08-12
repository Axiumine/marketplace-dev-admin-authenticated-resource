import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwConflictError } from '@axiumine/koa-utils/graphQL/throw/throwConflictError'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { rotateKeygripKeys } from '@axiumine/marketplace-common/encryption/rotateKeygripKeys'
import { wrapKeygripKeys } from '@axiumine/marketplace-common/encryption/wrapKeygripKeys'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { IKeygripRecord, readKeygrip } from '@axiumine/marketplace-common/others/readKeygrip'
import { keygripChannel, keygripKey } from '@axiumine/marketplace-common/others/sessionKeys'
import * as Sentry from '@sentry/node'
import { Types } from 'mongoose'

/**
 * The whole write, as one script: compare the version, replace all three fields, announce it.
 *
 * ⚠️ **The compare is what stops two operators from minting two different key sets under one version
 * number.** Both would read version 3, both would compute 4, and the second `HSET` would overwrite the
 * first — leaving services that already adopted the first version 4 signing with keys the record no
 * longer holds, while every later check compares version numbers and finds them equal. The split would
 * survive until someone rotated again. Here the loser writes nothing and is told to retry.
 *
 * ⚠️ **All three fields in one `HSET`, never three commands.** The version is the AAD the blob is
 * authenticated under (see `wrapKeygripKeys`), so a record whose `version` and `wrapped` come from
 * different rotations does not unwrap at all — a service booting in that window would refuse to start.
 * `HSET` with three pairs is one atomic write; the window does not exist.
 *
 * ⚠️ **A script rather than `WATCH` + `MULTI`, deliberately.** `WATCH` is scoped to a *connection*, and
 * node-redis multiplexes every command in the process over one — two rotations racing here would watch
 * the same key on the same connection, and the first `EXEC` would clear the second's watch. It would
 * look correct and protect nothing.
 *
 * The published payload is the new version number, and nothing else: a subscriber re-reads and unwraps
 * the record itself, so the channel never carries key material — see `watchKeygrip`.
 */
export const KEYGRIP_ROTATE_CAS = `if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'wrapped', ARGV[3], 'fp', ARGV[4])
redis.call('PUBLISH', ARGV[5], ARGV[2])
return 1`

/**
 * The one Redis verb this needs, and the reason it is written out here.
 *
 * `redisClient` is a union of the cluster and single-node clients, and calling a method on a union of
 * two generic signatures is not callable in TypeScript even when both members have it. Narrowing to the
 * shape actually used says what this file does with Redis — one scripted command, on one key — more
 * honestly than a cast to either client type would.
 */
interface IKeygripCasStore {
	eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/**
 * Rotates the fleet's cookie-signing keys, without restarting anything (ADR-034, E01-S13).
 *
 * ⚠️ **This is the only writer of the keygrip record on the platform** — the five signing services read
 * it and never write it, and the seed script runs once, before any of them exist.
 *
 * ⚠️ **No key material leaves this function.** Not to the caller, not to a log, not to Sentry. The
 * mutation answers `Boolean!` rather than the new key set for exactly that reason, and the audit event
 * below carries the operator's id, the new version and the fingerprint of the key *ids* — which is
 * public by construction, see `keygripFingerprint`. An operator who could read the material back would
 * be able to mint a session cookie for any account on the platform, which is a strictly larger power
 * than the one this mutation exists to grant.
 *
 * The three refusals, and what each asks of the operator:
 *
 * - the record cannot be read or opened — `readKeygrip`'s own two, reported as 500s. Nothing was
 *   written, and this service's `KEYGRIP_KEK` is either wrong or the record is gone.
 * - the key set is full and nothing in it has aged out — `rotateKeygripKeys`' cap, reported as a 409
 *   carrying the wait. Retiring a key that is still verifying cookies would log those customers out.
 * - somebody rotated first — the compare above failed, reported as a 409. Retry: the second rotation is
 *   built on the first one's record.
 */
export async function funKeygripRotate(_id: Types.ObjectId): Promise<void> {
	// Reads and unwraps, or throws. Deliberately not `loadKeygrip`: that one announces its caller in the
	// holders table, and this service holds the KEK to reseal the record, never to sign a cookie — a row
	// here would be a permanently stale entry in the table E01-S14 reads to find stale entries.
	let record: IKeygripRecord
	try {
		record = await readKeygrip(redisClient)
	} catch (e) {
		// The message names a version and a fingerprint and nothing else, and it is the only thing that
		// tells an operator whether to fix this service's env or to re-seed the fleet.
		throwInternalError((e as Error).message)
	}

	// The same variable `readKeygrip` has just proved is present and exactly 32 bytes — an unwrap that
	// succeeded is a stronger check than re-validating the length here would be.
	const kek = Buffer.from(process.env.KEYGRIP_KEK as string, 'base64')

	// The key-lifecycle rules — mint, prepend, retire what has aged past the longest session this
	// platform issues, never fall below two, refuse rather than trim — are one shared function, so the
	// admin panel and any future automation cannot disagree about them. Its only failure is the cap.
	let keys: IKeygripKeyMaterial[]
	try {
		keys = rotateKeygripKeys(record.keys, new Date())
	} catch (e) {
		throwConflictError((e as Error).message)
	}

	const version = record.version + 1

	const store = redisClient as unknown as IKeygripCasStore

	const written = await store.eval(KEYGRIP_ROTATE_CAS, {
		keys: [keygripKey()],
		arguments: [
			String(record.version),
			String(version),
			wrapKeygripKeys(keys, version, kek),
			keygripFingerprint(keys),
			keygripChannel()
		]
	})

	if (written !== 1)
		throwConflictError(
			'The keygrip record changed while this rotation was being prepared, so nothing was written. Another operator rotated a moment ago — reload the page and rotate again if you still need to.'
		)

	/*
	 * The audit trail, and the only record that this happened at all. Rotating the signing keys is the
	 * most powerful thing an operator can do to sessions on this platform, and it leaves no document
	 * behind — the record it writes holds no author. `captureMessage` at info level is what the boot
	 * banner already uses; a missing DSN makes it inert rather than fatal.
	 */
	Sentry.captureMessage(`keygrip rotated to version ${version} (${keygripFingerprint(keys)}) by admin ${_id.toString()}`, 'info')
}
