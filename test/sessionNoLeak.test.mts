import { hashSessionToken } from '@axiumine/marketplace-common/others/hashSessionToken'
import { graphql, GraphQLSchema } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * E17-S07, backend half.
 *
 * ⚠️ **Nothing below this line is stubbed except the network.** The store is real enough to answer the
 * commands the libs issue, the libs are the shipped ones, the schema is the assembled one, and the two
 * credentials are seeded into the store the way the platform actually stores them. That is the whole
 * point: a test that stubbed `funSessions` to hand back a token would be asserting that GraphQL
 * serialises what it is given, which is not in doubt and is not what leaks. What leaks is a lib that
 * reads a whole session hash and forwards a field nobody audited, or a resolver that answers an error
 * carrying the key it just failed to unwrap.
 *
 * ⚠️ **The loop is the mechanism, not a convenience.** A query or mutation added to this epic later has
 * to appear in `OPERATIONS` to be exercised at all, and the moment it does it inherits both seeds and
 * both assertions — there is no way to add a console operation that is checked by nothing without also
 * deleting a row here, which is a visible act rather than an omission.
 */

/** The refresh token an operator's own session was minted from. Prefixed, exactly as the platform hashes it. */
const TOKEN = 'refresh:27119032-9043-4a9f-bd4c-9d06fd576290'
/** The bare lineage-shaped half of it. Checked separately so a resolver that strips the scheme still fails. */
const TOKEN_BODY = '27119032-9043-4a9f-bd4c-9d06fd576290'
/** A cookie-signing key, in the shape `keygripKey()` holds one: the wrapped blob's own bytes. */
const KEY = 'Zm9yYmlkZGVuLXNpZ25pbmcta2V5LW1hdGVyaWFsLTAwMDAwMDAw'

const ACCOUNT = '68b0f2c1a2b3c4d5e6f70819'
const OPERATOR = new Types.ObjectId('507f1f77bcf86cd799439011')
const FAMILY = 'a2df6d1e-51f0-4a4e-9c0f-2b2f4f0f1a77'
const MINTED_AT = '1754784000000'

/** The digest the index files this session under, and therefore the `id` the console renders. */
const FIELD = hashSessionToken(TOKEN)

const store = new Map<string, Record<string, string> | string[] | string>()

const hashAt = (key: string) => (store.get(key) as Record<string, string> | undefined) ?? {}

/*
 * A Redis stand-in over a Map, covering only the commands these four operations issue. It is deliberately
 * dumb: every command reads and writes the same seeded state, so a lib that asked for a key it should not
 * (the keygrip record, say) would get the real seeded value back rather than an empty stub, and the
 * assertion below would see it.
 */
const redisClient = {
	hGetAll: (key: string) => Promise.resolve({ ...hashAt(key) }),
	hKeys: (key: string) => Promise.resolve(Object.keys(hashAt(key))),
	hDel: (key: string, field: string) => {
		const hash = store.get(key) as Record<string, string> | undefined
		const existed = typeof hash?.[field] !== 'undefined'

		if (hash) delete hash[field]

		return Promise.resolve(existed ? 1 : 0)
	},
	del: (key: string) => Promise.resolve(store.delete(key) ? 1 : 0),
	lRange: (key: string, start: number, stop: number) =>
		Promise.resolve(((store.get(key) as string[] | undefined) ?? []).slice(start, stop + 1)),
	incr: (key: string) => {
		const next = Number((store.get(key) as string | undefined) ?? '0') + 1

		store.set(key, `${next}`)

		return Promise.resolve(next)
	},
	ttl: () => Promise.resolve(60),
	expire: () => Promise.resolve(true)
}

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient }))

const { default: QueriesApi } = await import('../src/graphQLApi/schema/queries.mts')
const { default: MutationsApi } = await import('../src/graphQLApi/schema/mutations.mts')

const schema = new GraphQLSchema({ query: QueriesApi, mutation: MutationsApi })
const ctx = { state: { user: { _id: OPERATOR, email: 'operator@marketplace.test' } } }

const prefix = process.env.REDIS_KEY

beforeEach(() => {
	store.clear()

	// The account's index: one live session, filed under the digest of the seeded token.
	store.set(`${prefix}idx:shopOwner:${ACCOUNT}`, { [FIELD]: JSON.stringify({ tier: 'shopOwner', mintedAt: MINTED_AT }) })

	/*
	 * The session hash itself, at the key the digest names, with more in it than the console renders —
	 * `email` and `originalLogin` and the rest are there precisely so that a lib forwarding the hash
	 * wholesale would be visible. The token is not a field of it: the key *is* the token's digest, which
	 * is E13-S01's whole point and the reason the seeded value can only leak through a mistake.
	 */
	store.set(`${prefix}${FIELD}`, {
		_id: ACCOUNT,
		tier: 'shopOwner',
		familyId: FAMILY,
		originalLogin: MINTED_AT,
		email: 'owner@marketplace.test',
		disabled: 'false'
	})

	store.set(`${prefix}reuse:shopOwner:${ACCOUNT}`, [
		JSON.stringify({ familyId: FAMILY, tier: 'shopOwner', accountId: ACCOUNT, action: 'refreshTokenReplayed', at: MINTED_AT })
	])

	/*
	 * The signing keys, in the same database the console's own client is pointed at. No operation this
	 * epic adds has any business reading this key — seeding it is how "has any business" stops being an
	 * assumption and becomes an assertion.
	 */
	store.set(`${prefix}keygrip`, { version: '3', wrapped: KEY, fp: 'fp-4a1c' })
})

const OPERATIONS: Array<[string, string]> = [
	['sessions', `{ sessions(tier: shopOwner, accountId: "${ACCOUNT}") { id tier mintedAt familyId } }`],
	['reuseEvents', `{ reuseEvents(tier: shopOwner, accountId: "${ACCOUNT}") { familyId tier accountId action at } }`],
	['revokeSession', `mutation { revokeSession(tier: shopOwner, accountId: "${ACCOUNT}", id: "${FIELD}") }`],
	['revokeAllSessions', `mutation { revokeAllSessions(tier: shopOwner, accountId: "${ACCOUNT}") }`]
]

describe('no operation the session console adds can put a credential on the wire', () => {
	it.each(OPERATIONS)('%s answers without the seeded token or the seeded key anywhere in it', async (_name, source) => {
		const result = await graphql({ schema, source, contextValue: ctx as never })

		// The operation really ran. Asserting the cleanliness of an error response would pass on an
		// operation that never touched the store, which is the one way this test could lie.
		expect(result.errors).toBeUndefined()

		const serialised = JSON.stringify(result)

		expect(serialised).not.toContain(TOKEN)
		expect(serialised).not.toContain(TOKEN_BODY)
		expect(serialised).not.toContain(KEY)
	})

	/*
	 * ⚠️ The check above passes trivially on a response with nothing in it, so what the seeds actually
	 * reach has to be pinned down or the loop is worth nothing. The two halves are not symmetric, and the
	 * difference is the point:
	 *
	 * **The key is there.** Reachable from the same client the console's libs hold, one `hGetAll` away.
	 * Nothing stops an operation reading it except an operation not doing so, which is what the loop
	 * asserts.
	 *
	 * **The token is not there, anywhere, and cannot be.** E13-S01 replaced raw-token keys with digests:
	 * the platform stores `sha256(prefixedRefreshToken)` and never the token, so a console operation
	 * cannot leak it by forwarding something — only by reconstructing it, which sha256 does not permit.
	 * The loop's token assertion is therefore a *regression* guard rather than a live check: it is the
	 * test that fails if raw-token storage ever comes back, whether through `legacySessionKey` outliving
	 * its deadline or a new field written in the clear.
	 */
	it('is checking a store that holds the key in the clear and the token nowhere at all', () => {
		const serialisedStore = JSON.stringify([...store.entries()])

		expect(serialisedStore).toContain(KEY)
		expect(serialisedStore).not.toContain(TOKEN)
		expect(serialisedStore).not.toContain(TOKEN_BODY)
		// What is there instead, in both places the token would otherwise have been: its digest.
		expect(serialisedStore).toContain(FIELD)
	})

	// And the digest is not the token, which is the reason `sessions` may publish it and `revokeSession`
	// may take it back. The argument is written out on `ISessionRow`; this is it as an executable claim.
	it('renders a session id that is a digest, not the credential it was derived from', async () => {
		const result = await graphql({ schema, source: OPERATIONS[0][1], contextValue: ctx as never })
		const [row] = (result.data as { sessions: Array<{ id: string }> }).sessions

		expect(row.id).toBe(FIELD)
		expect(row.id).toHaveLength(64)
		expect(row.id).toMatch(/^[0-9a-f]{64}$/)
		expect(TOKEN).not.toContain(row.id)
	})
})
