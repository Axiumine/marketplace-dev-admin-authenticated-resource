import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { IKeygripRecord, readKeygrip } from '@axiumine/marketplace-common/others/readKeygrip'
import { keygripHoldersKey } from '@axiumine/marketplace-common/others/sessionKeys'

/** One key of the record, with the material left where it is. */
export interface IKeygripKeyInfo {
	id: string
	createdAt: string
	ageDays: number
}

/** One service that has read the record and is signing with what it read. */
export interface IKeygripHolder {
	service: string
	fingerprint: string
	lastSeen: string
	current: boolean
}

/** What the operator's screen renders. */
export interface IKeygripStatus {
	version: number
	fingerprint: string
	keys: IKeygripKeyInfo[]
	holders: IKeygripHolder[]
}

const DAY_MS = 86_400_000

/**
 * Splits a holders row into its two halves.
 *
 * `<fingerprint>@<ISO-8601>`, written by `recordKeygripHolder` — and split on the **first** `@`, because
 * the timestamp contains none while a future fingerprint format might. A row that does not carry one at
 * all yields an empty timestamp rather than throwing: this is a status screen, and one malformed row must
 * not be the reason an operator cannot see the other five.
 */
function splitHolderRow(row: string) {
	const at = row.indexOf('@')

	return at === -1 ? { fingerprint: row, lastSeen: '' } : { fingerprint: row.slice(0, at), lastSeen: row.slice(at + 1) }
}

/**
 * Everything an operator needs to answer "has the rotation landed everywhere yet" (ADR-034, E01-S14).
 *
 * ⚠️ **No key material is read, returned or logged.** `readKeygrip` unwraps the record because that is
 * the only way to learn the ids and the dates, and this function drops `material` on the way out — the
 * GraphQL types it feeds have no field for it, and `schema.test.mts` asserts that by name. An operator
 * who could read one key back could mint a session cookie for any account on the platform.
 *
 * ⚠️ **Reading, not holding.** `readKeygrip` rather than `loadKeygrip`, so opening this screen does not
 * file a holders row for a service that signs nothing — the same reason `funKeygripRotate` reads that
 * way. A row for this service would sit in the table without a heartbeat behind it, and the table's whole
 * job is telling those apart.
 *
 * The holders hash is read separately and is allowed to be empty: `HGETALL` on a missing key answers `{}`,
 * which is what a fleet that has not booted since the last flush looks like. That is a real state and it
 * renders as an empty table — not as an error, and not as "everything is current".
 */
export async function funKeygripStatus(): Promise<IKeygripStatus> {
	let record: IKeygripRecord
	try {
		record = await readKeygrip(redisClient)
	} catch (e) {
		// Names a version and a fingerprint at most — see `readKeygrip`. It is also the only thing that
		// tells an operator whether to fix this service's env or to re-seed the fleet.
		throwInternalError((e as Error).message)
	}

	const rows = (await redisClient.hGetAll(keygripHoldersKey())) as Record<string, string>
	const now = Date.now()

	return {
		version: record.version,
		fingerprint: record.fp,
		keys: record.keys.map((key) => ({
			id: key.id,
			createdAt: key.createdAt,
			// Floored, so "29" means the key has not finished its thirtieth day and the rotation will still
			// refuse to retire it. Rounding would show 30 for a key the server considers 29 days old.
			ageDays: Math.floor((now - new Date(key.createdAt).getTime()) / DAY_MS)
		})),
		// Sorted by service name so the table does not reshuffle between polls — Redis hash fields come
		// back in whatever order the keyspace holds them, which is stable for nobody.
		holders: Object.keys(rows)
			.sort()
			.map((service) => {
				const { fingerprint, lastSeen } = splitHolderRow(rows[service])

				return { service, fingerprint, lastSeen, current: fingerprint === record.fp }
			})
	}
}
