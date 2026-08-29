import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { wrapKeygripKeys } from '@axiumine/marketplace-common/encryption/wrapKeygripKeys'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'
import { keygripChannel, keygripKey } from '@axiumine/marketplace-common/others/sessionKeys'

/**
 * The whole write, as one script: compare the version, replace all three fields, announce it.
 *
 * ⚠️ **The compare is what stops two admins from writing two different key sets under one version
 * number.** Both would read version 3, both would compute 4, and the second `HSET` would overwrite the
 * first — leaving services that already adopted the first version 4 signing with keys the record no
 * longer holds, while every later check compares version numbers and finds them equal. The split would
 * survive until someone rotated again. Here the loser writes nothing and is told to retry.
 *
 * ⚠️ **All three fields in one `HSET`, never three commands.** The version is the AAD the blob is
 * authenticated under (see `wrapKeygripKeys`), so a record whose `version` and `wrapped` come from
 * different writes does not unwrap at all — a service booting in that window would refuse to start.
 * `HSET` with three pairs is one atomic write; the window does not exist.
 *
 * ⚠️ **A script rather than `WATCH` + `MULTI`, deliberately.** `WATCH` is scoped to a *connection*, and
 * node-redis multiplexes every command in the process over one — two writes racing here would watch the
 * same key on the same connection, and the first `EXEC` would clear the second's watch. It would look
 * correct and protect nothing.
 *
 * The published payload is the new version number, and nothing else: a subscriber re-reads and unwraps
 * the record itself, so the channel never carries key material — see `watchKeygrip`.
 */
export const KEYGRIP_CAS = `if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then return 0 end
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
 * Files a new key set under the next version, if nobody has moved the record since it was read.
 *
 * Both writing operations go through here — rotation mints and retirement removes, and neither is
 * allowed a second way of getting its result into Redis. What differs between them is the wording of the
 * refusal when the compare fails, so this answers whether the write landed and each caller says what to
 * do about it in its own words.
 *
 * ⚠️ **The version is not a parameter.** It is `expected + 1`, computed here, because the number the blob
 * is sealed under and the number the record is filed under are the same number by construction — a caller
 * that could pass them separately could seal a blob nothing can ever open.
 */
export async function keygripCasWrite(
	expected: number,
	keys: readonly IKeygripKeyMaterial[],
	kek: Buffer
): Promise<{ written: boolean; version: number }> {
	const version = expected + 1

	const store = redisClient as unknown as IKeygripCasStore

	const written = await store.eval(KEYGRIP_CAS, {
		keys: [keygripKey()],
		arguments: [
			String(expected),
			String(version),
			wrapKeygripKeys(keys, version, kek),
			keygripFingerprint(keys),
			keygripChannel()
		]
	})

	return { written: written === 1, version }
}
