import type { Mock } from 'vitest'
import { vi } from 'vitest'

/** The four Redis commands a session-index revocation talks to, faked. */
type SessionIndexMocks = { hKeys: Mock; hGet: Mock; del: Mock; hDel: Mock }

/**
 * The fixture the two revocation suites open every test with.
 *
 * `endEverySession` and `endEveryShopOwnerSession` fake the same client and arm it the same way: the index
 * answers with the fields it was given, `hGet` echoes the key back uppercased so an access key read out of
 * the session is unmistakably read rather than derived, and both deletes report one key removed. Only the
 * tier, the fields and the assertions differ, so the arming is the one part worth sharing.
 *
 * The mocks are passed in rather than created here: `vi.mock` is hoisted to the top of the file that
 * declares it, so the client each suite fakes has to be built in that suite's own module.
 *
 * Not a `*.test.mts` file on purpose: the unit project collects `test/*.test.mts`, so this sits beside the
 * suites without becoming one.
 */
export function armSessionIndex({ hKeys, hGet, del, hDel }: SessionIndexMocks, redisKey: string, fields: string[]): void {
	vi.stubEnv('REDIS_KEY', redisKey)
	hKeys.mockReset().mockResolvedValue(fields)
	hGet.mockReset().mockImplementation((key: string) => Promise.resolve(key.toUpperCase()))
	del.mockReset().mockResolvedValue(1)
	hDel.mockReset().mockResolvedValue(1)
}

/** The `REDIS_KEY` prefix every revocation suite stubs — all nine services share one, in test as in life. */
export const REDIS_KEY = 'test:'

/**
 * The two session fields the tier-revocation suites arm their index with — one account holding two live
 * sessions, which is the smallest set that can tell "revoked the session" from "revoked the account".
 */
export const INDEXED_FIELDS = ['a'.repeat(64), 'b'.repeat(64)]

/** The access key each session records under `accessKey` (R54). Uppercase, so it is read rather than derived. */
export const accessKeyOf = (field: string): string => `${REDIS_KEY}${field}`.toUpperCase()
