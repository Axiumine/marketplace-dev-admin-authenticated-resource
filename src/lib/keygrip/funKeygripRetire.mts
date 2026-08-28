import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwConflictError } from '@axiumine/koa-utils/graphQL/throw/throwConflictError'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { KEYGRIP_RETIRE_UNKNOWN, retireKeygripKey } from '@axiumine/marketplace-common/encryption/retireKeygripKey'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { readKek } from '@axiumine/marketplace-common/others/readKek'
import { IKeygripRecord, readKeygrip } from '@axiumine/marketplace-common/others/readKeygrip'
import { guardKeygripWrite } from '@lib/keygrip/guardKeygripWrite.mjs'
import { keygripCasWrite } from '@lib/keygrip/keygripCas.mjs'
import * as Sentry from '@sentry/node'
import { Types } from 'mongoose'

/**
 * Takes one named key out of the fleet's keyring, for a suspected compromise (ADR-034, E16-S04).
 *
 * ⚠️ **This is the one operation on the platform that logs customers out on purpose.** Every cookie the
 * retired key signed stops verifying as soon as each process picks the new record up — which is what an
 * operator responding to a leaked key is asking for, and why it is a separate button from rotation rather
 * than something rotation does quietly.
 *
 * ⚠️ **Retiring the key the platform signs with is refused, by the shared rule and not by a read here.**
 * `retireKeygripKey` decides that, so the admin panel and any future automation cannot disagree about it,
 * and there is no window between a check and the removal. The refusal names rotation, because rotation is
 * what moves a suspect key out of index 0 — after which this operation can take it.
 *
 * ⚠️ **No key material leaves this function**, for the reason spelled out in `funKeygripRotate`: the audit
 * event carries the retired key's *id*, the new version, the fingerprint of the ids and the operator, and
 * an operator who could read material back could mint a session cookie for any account on the platform.
 *
 * The five refusals: too many writes this hour (429), a record that cannot be read or opened (500), a key
 * id nothing matches (**404** — and the operator must read this as "nothing was retired", never as "it was
 * already gone"), the current key (409), and losing the compare to another operator (409).
 */
export async function funKeygripRetire(_id: Types.ObjectId, keyId: string): Promise<void> {
	await guardKeygripWrite('retire', _id.toString())

	// `readKeygrip`, not `loadKeygrip`: this service holds the KEK to reseal the record and signs no
	// cookie, so a holders row for it would be a heartbeat with nothing behind it.
	let record: IKeygripRecord
	try {
		record = await readKeygrip(redisClient)
	} catch (e) {
		throwInternalError((e as Error).message)
	}

	// One decode site, for the reason `funKeygripRotate` states in full (ADR-040).
	const kek = readKek()

	let keys: IKeygripKeyMaterial[]
	try {
		keys = retireKeygripKey(record.keys, keyId)
	} catch (e) {
		const reason = (e as Error).message

		/*
		 * ⚠️ Two refusals, two statuses, and the difference matters more here than anywhere else on this
		 * service. A 404 means the id is not in the key set *and nothing was removed*; an operator who read
		 * that as "already retired" would stop responding to a compromise that is still live. The code the
		 * message leads with is exported by the shared rule, so this branch cannot drift from it.
		 */
		if (reason.startsWith(KEYGRIP_RETIRE_UNKNOWN)) throwNotFoundError(reason)

		throwConflictError(reason)
	}

	const { written, version } = await keygripCasWrite(record.version, keys, kek)

	if (!written)
		throwConflictError(
			`The keygrip record changed while ${keyId} was being retired, so nothing was written and that key is still in use. Reload the page and retire it again.`
		)

	// The audit trail. The id is safe to name — it is what the fingerprint is computed over, and what the
	// status screen shows — and it is the only way to answer "when did we drop that key?" afterwards.
	Sentry.captureMessage(
		`keygrip key ${keyId} retired at version ${version} (${keygripFingerprint(keys)}) by admin ${_id.toString()}`,
		'info'
	)
}
